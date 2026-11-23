/**
 * 异步执行器：工作队列 + 技能派发 + 只读试跑 (mc_scout) + 自保反射。
 */
import type { Bot } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import type { BlueprintBook } from "./blueprint.ts";
import type { MarkBook } from "./marks.ts";
import { isSpawnAnchorBlock, type PolicySettings } from "./policy.ts";
import { hazardTouch } from "./terrain.ts";

const { goals, Movements } = pathfinderPkg;

export type QueueMode = "append" | "replace" | "interrupt";

export interface SkillStep {
  type: string;
  [key: string]: unknown;
}

export interface QueuedTask {
  id: string;
  label?: string;
  steps: SkillStep[];
  status: "queued" | "running" | "done" | "partial" | "blocked" | "cancelled";
  currentStep: number;
  completedSteps: number;
  error?: string;
  createdAt: string;
}

export interface BlockedRecord {
  taskId: string;
  stepIndex: number;
  stepType: string;
  reason: string;
  at: string;
}

export interface ExecutorDeps {
  getBot: () => Bot;
  getPolicy: () => PolicySettings;
  marks: MarkBook;
  blueprints: BlueprintBook;
  emitTask: (payload: Record<string, unknown>) => void;
  emitProgress: (payload: Record<string, unknown>) => void;
  emitEvent: (payload: Record<string, unknown>) => void;
}

const FACE_VECTORS: Record<string, [number, number, number]> = {
  up: [0, 1, 0],
  top: [0, 1, 0],
  down: [0, -1, 0],
  bottom: [0, -1, 0],
  north: [0, 0, -1],
  south: [0, 0, 1],
  east: [1, 0, 0],
  west: [-1, 0, 0],
};

function asVec3(pos: unknown, marks: MarkBook): Vec3 {
  if (typeof pos === "string") {
    const m = marks.get(pos);
    if (!m) throw new Error(`未知地点标记: ${pos}`);
    return new Vec3(m.position[0], m.position[1], m.position[2]);
  }
  if (Array.isArray(pos) && pos.length === 3 && pos.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return new Vec3(pos[0], pos[1], pos[2]);
  }
  throw new Error("坐标必须是 [x, y, z] 或已登记的地点名");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MinecraftExecutor {
  private readonly deps: ExecutorDeps;
  private readonly queue: QueuedTask[] = [];
  private readonly history: QueuedTask[] = [];
  private readonly blocked: BlockedRecord[] = [];
  private current: QueuedTask | null = null;
  private abortController: AbortController | null = null;
  private runningLoop = false;
  private seq = 1;
  private lastReflexAt = 0;

  constructor(deps: ExecutorDeps) {
    this.deps = deps;
  }

  enqueue(steps: SkillStep[], mode: QueueMode = "append", label?: string): QueuedTask {
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error("steps 必须是非空数组");
    }
    const task: QueuedTask = {
      id: `mc-${this.seq++}`,
      ...(label ? { label } : {}),
      steps,
      status: "queued",
      currentStep: 0,
      completedSteps: 0,
      createdAt: new Date().toISOString(),
    };

    if (mode === "replace" || mode === "interrupt") {
      this.clearPending("被新任务替换");
    }
    if (mode === "interrupt" && this.current) {
      this.abortCurrent("被高优先级任务打断");
    }

    this.queue.push(task);
    void this.pump();
    return task;
  }

  stopAll(reason = "用户/宿主请求停止"): { cancelledCurrent: boolean; clearedCount: number } {
    const clearedCount = this.clearPending(reason);
    const cancelledCurrent = this.abortCurrent(reason);
    return { cancelledCurrent, clearedCount };
  }

  queueSnapshot(): { running: QueuedTask | null; pending: QueuedTask[]; recent: QueuedTask[] } {
    return {
      running: this.current ? { ...this.current } : null,
      pending: this.queue.map((t) => ({ ...t })),
      recent: this.history.slice(-10),
    };
  }

  blockedSnapshot(): BlockedRecord[] {
    return [...this.blocked];
  }

  /** mc_scout：只读试跑，不修改世界，返回每步可行性评估 */
  scout(steps: SkillStep[]): { feasible: boolean; reports: Array<{ step: number; type: string; ok: boolean; note: string }> } {
    const bot = this.deps.getBot();
    const policy = this.deps.getPolicy();
    const reports: Array<{ step: number; type: string; ok: boolean; note: string }> = [];

    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      try {
        if (s.type === "goto") {
          const target = asVec3(s.position ?? s.mark, this.deps.marks);
          const dist = bot.entity.position.distanceTo(target);
          reports.push({
            step: i,
            type: s.type,
            ok: dist <= 128,
            note: dist <= 128 ? `距离目标 ${dist.toFixed(1)} 格` : `目标过远 (${dist.toFixed(1)} 格 > 128)`,
          });
        } else if (s.type === "dig") {
          const target = asVec3(s.position, this.deps.marks);
          const blk = bot.blockAt(target);
          if (!blk) {
            reports.push({ step: i, type: s.type, ok: false, note: "目标区块未加载" });
          } else if (blk.name === "air") {
            reports.push({ step: i, type: s.type, ok: false, note: "目标位置已经是空气" });
          } else if (isSpawnAnchorBlock(blk.name) && s.force !== true) {
            reports.push({ step: i, type: s.type, ok: false, note: `受保护的重生锚/床 (${blk.name})` });
          } else {
            reports.push({ step: i, type: s.type, ok: true, note: `可挖掘 ${blk.name}` });
          }
        } else if (s.type === "place") {
          const item = String(s.item ?? "");
          const has = bot.inventory.items().some((it) => it.name === item);
          reports.push({
            step: i,
            type: s.type,
            ok: has,
            note: has ? `背包有 ${item}` : `背包缺少 ${item}`,
          });
        } else if (s.type === "craft") {
          const itemName = String(s.item ?? "").replace(/^minecraft:/, "");
          const itemDef = bot.registry.itemsByName[itemName];
          if (!itemDef) {
            reports.push({ step: i, type: s.type, ok: false, note: `未知物品 ${itemName}` });
          } else {
            const table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 6 });
            const recipes = bot.recipesFor(itemDef.id, null, 1, table ?? null);
            reports.push({
              step: i,
              type: s.type,
              ok: recipes.length > 0,
              note: recipes.length > 0 ? `找到 ${recipes.length} 个可用配方` : "材料不足或缺少工作台",
            });
          }
        } else if (s.type === "build_blueprint") {
          const bp = this.deps.blueprints.current();
          reports.push({
            step: i,
            type: s.type,
            ok: Boolean(bp && bp.origin),
            note: bp ? (bp.origin ? `蓝图 ${bp.name} 已就绪` : `蓝图 ${bp.name} 缺少 origin`) : "未载入蓝图",
          });
        } else {
          reports.push({ step: i, type: s.type, ok: true, note: `语法合法 (${policy.travel} 模式)` });
        }
      } catch (err) {
        reports.push({
          step: i,
          type: s.type,
          ok: false,
          note: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { feasible: reports.every((r) => r.ok), reports };
  }

  /** 自主自保反射 tick：由 World 定时或受击事件触发 */
  async runReflexTick(): Promise<void> {
    let bot: Bot;
    try {
      bot = this.deps.getBot();
    } catch {
      return;
    }
    const policy = this.deps.getPolicy();
    const now = Date.now();
    if (now - this.lastReflexAt < 2500) return;

    const hazard = hazardTouch(bot);
    if (hazard === "lava" && policy.antiLava) {
      this.lastReflexAt = now;
      bot.setControlState("jump", true);
      bot.setControlState("back", true);
      this.deps.emitEvent({ kind: "reflex", type: "anti_lava", message: "接触岩浆/火焰，已触发紧急跳离" });
      setTimeout(() => {
        try {
          bot.setControlState("jump", false);
          bot.setControlState("back", false);
        } catch {
          /* ignore */
        }
      }, 600);
      return;
    }

    if (hazard === "drown" && policy.antiDrown) {
      this.lastReflexAt = now;
      bot.setControlState("jump", true);
      this.deps.emitEvent({ kind: "reflex", type: "anti_drown", message: "氧气不足，已上浮换气" });
      setTimeout(() => {
        try {
          bot.setControlState("jump", false);
        } catch {
          /* ignore */
        }
      }, 800);
      return;
    }

    if ((bot.health ?? 20) <= policy.fleeHealth) {
      const hostile = this.nearestHostile(bot, 6);
      if (hostile) {
        this.lastReflexAt = now;
        const away = bot.entity.position.minus(hostile.position).normalize().scaled(8);
        const dest = bot.entity.position.plus(away);
        try {
          bot.pathfinder.setGoal(new goals.GoalNear(dest.x, dest.y, dest.z, 2), false);
          this.deps.emitEvent({ kind: "reflex", type: "flee", message: `生命值过低 (${bot.health})，正在脱离危险` });
        } catch {
          /* ignore */
        }
      }
      return;
    }

    if (policy.fight !== "off") {
      const hostile = this.nearestHostile(bot, 3.2);
      if (hostile) {
        const hasWeapon = this.equipBestWeapon(bot);
        if (policy.fight === "auto" || hasWeapon) {
          this.lastReflexAt = now;
          try {
            await bot.lookAt(hostile.position.offset(0, 1.2, 0), true);
            bot.attack(hostile);
            this.deps.emitEvent({
              kind: "combat",
              type: "reflex_attack",
              target: hostile.name ?? hostile.type,
              message: `自卫反击 ${hostile.name ?? hostile.type}`,
            });
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  private nearestHostile(bot: Bot, maxDist: number): any | null {
    let best: any = null;
    let bestDist = maxDist;
    for (const e of Object.values(bot.entities)) {
      if (!e || e === bot.entity) continue;
      if (e.type !== "hostile" && e.kind !== "Hostile mobs") continue;
      const d = bot.entity.position.distanceTo(e.position);
      if (d <= bestDist) {
        best = e;
        bestDist = d;
      }
    }
    return best;
  }

  private equipBestWeapon(bot: Bot): boolean {
    const rank = ["netherite_sword", "diamond_sword", "iron_sword", "stone_sword", "wooden_sword", "iron_axe", "stone_axe"];
    for (const name of rank) {
      const found = bot.inventory.items().find((it) => it.name === name);
      if (found) {
        void bot.equip(found, "hand").catch(() => {});
        return true;
      }
    }
    return false;
  }

  private clearPending(reason: string): number {
    let count = 0;
    while (this.queue.length > 0) {
      const t = this.queue.shift()!;
      t.status = "cancelled";
      t.error = reason;
      this.recordHistory(t);
      this.deps.emitTask({ taskId: t.id, status: "cancelled", completedSteps: 0, totalSteps: t.steps.length, reason });
      count++;
    }
    return count;
  }

  private abortCurrent(reason: string): boolean {
    if (!this.current || !this.abortController) return false;
    this.abortController.abort(new Error(reason));
    try {
      const bot = this.deps.getBot();
      bot.pathfinder.setGoal(null);
      bot.stopDigging();
    } catch {
      /* ignore */
    }
    return true;
  }

  private recordHistory(task: QueuedTask): void {
    this.history.push({ ...task });
    if (this.history.length > 30) this.history.shift();
  }

  private recordBlocked(taskId: string, stepIndex: number, stepType: string, reason: string): void {
    this.blocked.push({ taskId, stepIndex, stepType, reason, at: new Date().toISOString() });
    if (this.blocked.length > 20) this.blocked.shift();
  }

  private async pump(): Promise<void> {
    if (this.runningLoop) return;
    this.runningLoop = true;
    try {
      while (this.queue.length > 0) {
        const task = this.queue.shift()!;
        this.current = task;
        task.status = "running";
        const ac = new AbortController();
        this.abortController = ac;

        this.deps.emitProgress({
          taskId: task.id,
          status: "running",
          currentStep: 0,
          totalSteps: task.steps.length,
        });

        let failedReason: string | undefined;
        for (let i = 0; i < task.steps.length; i++) {
          if (ac.signal.aborted) {
            failedReason = ac.signal.reason instanceof Error ? ac.signal.reason.message : "任务已取消";
            break;
          }
          task.currentStep = i;
          const step = task.steps[i];
          this.deps.emitProgress({
            taskId: task.id,
            status: "running",
            currentStep: i,
            stepType: step.type,
            totalSteps: task.steps.length,
          });

          try {
            await this.runStep(step, ac.signal);
            task.completedSteps += 1;
          } catch (err) {
            failedReason = err instanceof Error ? err.message : String(err);
            this.recordBlocked(task.id, i, step.type, failedReason);
            break;
          }
        }

        if (ac.signal.aborted) {
          task.status = "cancelled";
          task.error = failedReason ?? "已取消";
        } else if (failedReason) {
          task.status = task.completedSteps > 0 ? "partial" : "blocked";
          task.error = failedReason;
        } else {
          task.status = "done";
        }

        this.recordHistory(task);
        this.deps.emitTask({
          taskId: task.id,
          status: task.status,
          completedSteps: task.completedSteps,
          totalSteps: task.steps.length,
          ...(task.error ? { error: task.error } : {}),
        });
        this.current = null;
        this.abortController = null;
      }
    } finally {
      this.runningLoop = false;
    }
  }

  private applyMovements(bot: Bot): void {
    const policy = this.deps.getPolicy();
    const movements = new Movements(bot);
    movements.canDig = policy.travel !== "place";
    movements.allowParkour = false;
    const scaffoldIds: number[] = [];
    if (policy.travel !== "dig") {
      for (const name of policy.scaffold) {
        const item = bot.registry.itemsByName[name];
        if (item) scaffoldIds.push(item.id);
      }
    }
    movements.scafoldingBlocks = scaffoldIds;
    bot.pathfinder.setMovements(movements);
  }

  private async runStep(step: SkillStep, signal: AbortSignal): Promise<void> {
    const bot = this.deps.getBot();
    if (signal.aborted) throw new Error("任务已取消");

    switch (step.type) {
      case "goto": {
        const dest = asVec3(step.position ?? step.mark, this.deps.marks);
        const dist = typeof step.distance === "number" ? Math.max(0, Math.min(4, step.distance)) : 1;
        this.applyMovements(bot);
        const goal = dist > 0 ? new goals.GoalNear(dest.x, dest.y, dest.z, dist) : new goals.GoalBlock(dest.x, dest.y, dest.z);
        await bot.pathfinder.goto(goal);
        return;
      }

      case "look": {
        const target = asVec3(step.position ?? step.mark, this.deps.marks);
        await bot.lookAt(target.offset(0.5, 0.5, 0.5), true);
        return;
      }

      case "dig": {
        const target = asVec3(step.position, this.deps.marks);
        const blk = bot.blockAt(target);
        if (!blk || blk.name === "air") throw new Error("目标位置没有可挖掘方块");
        if (isSpawnAnchorBlock(blk.name) && step.force !== true) {
          throw new Error(`拒绝挖掘受保护的重生锚/床: ${blk.name}`);
        }
        await this.equipBestToolFor(bot, blk.name);
        await bot.dig(blk);
        return;
      }

      case "gather": {
        const blockName = String(step.block ?? step.item ?? "").replace(/^minecraft:/, "");
        const count = typeof step.count === "number" && step.count > 0 ? Math.min(step.count, 32) : 1;
        if (!blockName) throw new Error("gather 需要指定 block 名称");
        for (let k = 0; k < count; k++) {
          if (signal.aborted) throw new Error("任务已取消");
          const found = bot.findBlock({
            matching: (b) => b.name === blockName || b.name.includes(blockName),
            maxDistance: 32,
          });
          if (!found) throw new Error(`附近 32 格内找不到 ${blockName}`);
          this.applyMovements(bot);
          await bot.pathfinder.goto(new goals.GoalNear(found.position.x, found.position.y, found.position.z, 2));
          await this.equipBestToolFor(bot, found.name);
          await bot.dig(found);
          await sleep(250);
        }
        return;
      }

      case "place": {
        const target = asVec3(step.position, this.deps.marks);
        const faceKey = String(step.face ?? "up").toLowerCase();
        const vec = FACE_VECTORS[faceKey];
        if (!vec) throw new Error(`未知表面方向: ${faceKey}`);
        const itemName = String(step.item ?? "").replace(/^minecraft:/, "");
        const item = bot.inventory.items().find((it) => it.name === itemName);
        if (!item) throw new Error(`背包里没有 ${itemName}`);
        const ref = bot.blockAt(target);
        if (!ref || ref.name === "air") throw new Error("支撑方块不存在或为空气");
        await bot.equip(item, "hand");
        await bot.placeBlock(ref, new Vec3(vec[0], vec[1], vec[2]));
        return;
      }

      case "build_blueprint": {
        const bp = this.deps.blueprints.current();
        if (!bp || !bp.origin) throw new Error("未载入带 origin 的蓝图");
        const [ox, oy, oz] = bp.origin;
        for (let y = 0; y < bp.size_xyz[1]; y++) {
          for (let z = 0; z < bp.size_xyz[2]; z++) {
            for (let x = 0; x < bp.size_xyz[0]; x++) {
              if (signal.aborted) throw new Error("任务已取消");
              const want = bp.layers[y][z][x];
              if (want === "air" || want === "structure_void") continue;
              const cell = new Vec3(ox + x, oy + y, oz + z);
              const cur = bot.blockAt(cell);
              if (cur && cur.name === want) continue;
              const item = bot.inventory.items().find((it) => it.name === want);
              if (!item) throw new Error(`建造蓝图缺少材料: ${want}`);
              this.applyMovements(bot);
              await bot.pathfinder.goto(new goals.GoalNear(cell.x, cell.y, cell.z, 3));
              const below = bot.blockAt(cell.offset(0, -1, 0));
              if (!below || below.name === "air") throw new Error(`(${cell.x},${cell.y},${cell.z}) 下方无支撑方块`);
              await bot.equip(item, "hand");
              await bot.placeBlock(below, new Vec3(0, 1, 0));
            }
          }
        }
        return;
      }

      case "equip": {
        const itemName = String(step.item ?? "").replace(/^minecraft:/, "");
        const dest = (String(step.destination ?? "hand") as any);
        const item = bot.inventory.items().find((it) => it.name === itemName);
        if (!item) throw new Error(`背包里没有 ${itemName}`);
        await bot.equip(item, dest);
        return;
      }

      case "eat": {
        const itemName = String(step.item ?? "").replace(/^minecraft:/, "");
        const item = itemName
          ? bot.inventory.items().find((it) => it.name === itemName)
          : bot.inventory.items().find((it) => Boolean(bot.registry.foodsByName[it.name]));
        if (!item) throw new Error("背包里没有可食用的食物");
        await bot.equip(item, "hand");
        await bot.consume();
        return;
      }

      case "drop": {
        const itemName = String(step.item ?? "").replace(/^minecraft:/, "");
        const item = bot.inventory.items().find((it) => it.name === itemName);
        if (!item) throw new Error(`背包里没有 ${itemName}`);
        const count = typeof step.count === "number" ? Math.min(step.count, item.count) : item.count;
        await bot.toss(item.type, null, count);
        return;
      }

      case "craft": {
        const itemName = String(step.item ?? "").replace(/^minecraft:/, "");
        const count = typeof step.count === "number" && step.count > 0 ? step.count : 1;
        const itemDef = bot.registry.itemsByName[itemName];
        if (!itemDef) throw new Error(`未知物品: ${itemName}`);
        const table = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 6 });
        const recipes = bot.recipesFor(itemDef.id, null, 1, table ?? null);
        if (recipes.length === 0) throw new Error(`没有可用的 ${itemName} 合成配方或材料不足`);
        await bot.craft(recipes[0], count, table ?? undefined);
        return;
      }

      case "interact": {
        const target = asVec3(step.position, this.deps.marks);
        const blk = bot.blockAt(target);
        if (!blk || blk.name === "air") throw new Error("目标方块不存在");
        await bot.activateBlock(blk);
        return;
      }

      case "attack": {
        const targetName = String(step.target ?? "").toLowerCase();
        const entity = Object.values(bot.entities).find(
          (e) =>
            e &&
            e !== bot.entity &&
            bot.entity.position.distanceTo(e.position) <= 6 &&
            (!targetName ||
              String(e.name ?? "").toLowerCase().includes(targetName) ||
              String(e.username ?? "").toLowerCase().includes(targetName)),
        );
        if (!entity) throw new Error(`附近 6 格内未找到目标实体: ${targetName || "any"}`);
        this.equipBestWeapon(bot);
        await bot.lookAt(entity.position.offset(0, 1.2, 0), true);
        bot.attack(entity);
        return;
      }

      case "say": {
        const text = String(step.text ?? "").trim();
        if (!text || text.startsWith("/")) throw new Error("say 仅支持普通单行聊天");
        bot.chat(text.slice(0, 240));
        return;
      }

      case "wait": {
        const ms = typeof step.ms === "number" ? Math.min(Math.max(step.ms, 50), 30_000) : 1000;
        await sleep(ms);
        return;
      }

      default:
        throw new Error(`不支持的技能类型: ${step.type}`);
    }
  }

  private async equipBestToolFor(bot: Bot, blockName: string): Promise<void> {
    const policy = this.deps.getPolicy();
    const reserve = new Set(policy.reserve);
    const items = bot.inventory.items().filter((it) => !reserve.has(it.name));
    const preferAxe = blockName.includes("log") || blockName.includes("planks") || blockName.includes("wood");
    const preferShovel = blockName.includes("dirt") || blockName.includes("sand") || blockName.includes("gravel");
    const suffix = preferAxe ? "_axe" : preferShovel ? "_shovel" : "_pickaxe";
    const tiers = ["netherite", "diamond", "iron", "stone", "golden", "wooden"];
    for (const t of tiers) {
      const found = items.find((it) => it.name === `${t}${suffix}`);
      if (found) {
        await bot.equip(found, "hand");
        return;
      }
    }
  }
}
