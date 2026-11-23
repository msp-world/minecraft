/**
 * Minecraft MSP World —— 完整复刻 Cortico worlds/minecraft 的工具与事件流契约，
 * 并兼容 msp-test 的 mc_status / mc_observe / mc_block / mc_say。
 */
import mineflayer from "mineflayer";
import type { Bot } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import type { MSPNode } from "../shared/msp.ts";
import { BlueprintBook, type BlueprintDef, type PositionXYZ } from "./blueprint.ts";
import { evaluateChecks, type CheckAssertion } from "./check.ts";
import { MinecraftExecutor, type QueueMode, type SkillStep } from "./executor.ts";
import { GoalBook, type GoalStatus } from "./goals.ts";
import { MarkBook } from "./marks.ts";
import { applyPolicyPatch, defaultPolicy, type PolicySettings } from "./policy.ts";
import { inventorySummary, snapshotFromBot, worldDelta, type WorldSnapshot } from "./terrain.ts";

const { pathfinder } = pathfinderPkg;

export interface MinecraftConfig {
  host: string;
  port: number;
  username: string;
  version: string;
  auth?: "offline" | "microsoft";
  worldTickMs?: number;
  snapshotIntervalMs?: number;
  moveThreshold?: number;
}

export class MinecraftWorld {
  private readonly cfg: Required<MinecraftConfig>;
  private readonly marks = new MarkBook();
  private readonly goals = new GoalBook();
  private readonly blueprints = new BlueprintBook();
  private policy: PolicySettings = defaultPolicy();
  private executor: MinecraftExecutor;
  private node: MSPNode | null = null;
  private bot: Bot | null = null;
  private phase: "offline" | "connecting" | "online" = "offline";
  private reason: string | undefined;
  private stopping = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private lastWorldSnap: WorldSnapshot | null = null;
  private lastSnapshotAt = 0;

  constructor(config: MinecraftConfig) {
    this.cfg = {
      host: config.host,
      port: config.port,
      username: config.username,
      version: config.version,
      auth: config.auth ?? "offline",
      worldTickMs: config.worldTickMs ?? 4_000,
      snapshotIntervalMs: config.snapshotIntervalMs ?? 15_000,
      moveThreshold: config.moveThreshold ?? 12,
    };

    this.executor = new MinecraftExecutor({
      getBot: () => this.onlineBot(),
      getPolicy: () => this.policy,
      marks: this.marks,
      blueprints: this.blueprints,
      emitTask: (p) => this.node?.publish("minecraft.task", p),
      emitProgress: (p) => this.node?.publish("minecraft.task.progress", p),
      emitEvent: (p) => this.node?.publish("minecraft.event", p),
    });
  }

  attach(node: MSPNode): void {
    this.node = node;

    const signals: [string, string][] = [
      ["minecraft.task", "工作队列任务结局（done/partial/blocked/cancelled）"],
      ["minecraft.task.progress", "正在执行任务的步骤进度"],
      ["minecraft.chat", "游戏内聊天、私聊与系统消息"],
      ["minecraft.event", "受伤、战斗、死亡、自保反射与连接事件"],
      ["minecraft.world", "位置、生命、昼夜、天气等增量变化"],
      ["minecraft.world.snapshot", "定期世界快照（环境/背包/队列/目标/地点）"],
      ["minecraft.connection", "连接状态变化（offline/connecting/online）"],
    ];
    for (const [p, desc] of signals) node.declareSignal(p, desc);

    // ── Cortico 13 工具 ────────────────────────────────────────────────
    node.tool(
      "mc_do",
      "把一组有序技能（goto/dig/gather/place/craft/build_blueprint/equip/eat/attack/say/wait 等）排入工作队列，立即返回 taskId",
      (args) => {
        this.onlineBot();
        const steps = Array.isArray(args.steps) ? (args.steps as SkillStep[]) : [];
        const mode = (args.mode === "replace" || args.mode === "interrupt" ? args.mode : "append") as QueueMode;
        const label = typeof args.label === "string" ? args.label : undefined;
        const scout = args.precheck !== false ? this.executor.scout(steps) : null;
        const task = this.executor.enqueue(steps, mode, label);
        return {
          taskId: task.id,
          status: task.status,
          steps: task.steps.length,
          ...(scout ? { precheck: scout } : {}),
        };
      },
      {
        type: "object",
        required: ["steps"],
        properties: {
          steps: { type: "array", items: { type: "object" }, minItems: 1 },
          mode: { type: "string", enum: ["append", "replace", "interrupt"], default: "append" },
          label: { type: "string" },
          precheck: { type: "boolean", default: true },
        },
      },
    );

    node.tool(
      "mc_scout",
      "用与 mc_do 相同的技能列表做只读试跑，评估可行性与材料/距离，不改动世界",
      (args) => {
        this.onlineBot();
        const steps = Array.isArray(args.steps) ? (args.steps as SkillStep[]) : [];
        return this.executor.scout(steps);
      },
      {
        type: "object",
        required: ["steps"],
        properties: { steps: { type: "array", items: { type: "object" }, minItems: 1 } },
      },
    );

    node.tool(
      "mc_policy",
      "读取或修改常驻规矩（scaffold/light/lightWhen/travel/reserve/fight/fleeHealth/antiLava/antiDrown），立即生效",
      (args) => {
        const { next, notes } = applyPolicyPatch(this.policy, args);
        this.policy = next;
        return { policy: this.policy, notes };
      },
      {
        type: "object",
        properties: {
          scaffold: { type: "array", items: { type: "string" } },
          light: { type: "array", items: { type: "string" } },
          lightWhen: { type: "string", enum: ["dig", "anywhere"] },
          travel: { type: "string", enum: ["auto", "dig", "place"] },
          reserve: { type: "array", items: { type: "string" } },
          fight: { type: "string", enum: ["auto", "armed", "off"] },
          fleeHealth: { type: "number", minimum: 0, maximum: 20 },
          antiLava: { type: "boolean" },
          antiDrown: { type: "boolean" },
        },
      },
    );

    node.tool(
      "mc_goal",
      "登记、更新、完成或列出世界目标（最多 5 个活跃目标）",
      (args) => {
        const action = String(args.action ?? "list");
        if (action === "add") {
          const g = this.goals.add(String(args.title ?? ""), typeof args.note === "string" ? args.note : undefined);
          return { goal: g };
        }
        if (action === "update" || action === "complete" || action === "drop") {
          const status: GoalStatus =
            action === "complete" ? "done" : action === "drop" ? "dropped" : ((args.status as GoalStatus) ?? "active");
          const g = this.goals.update(String(args.id ?? ""), status, typeof args.note === "string" ? args.note : undefined);
          return { goal: g };
        }
        return { goals: this.goals.list(args.includeClosed === true) };
      },
      {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "add", "update", "complete", "drop"], default: "list" },
          id: { type: "string" },
          title: { type: "string" },
          status: { type: "string", enum: ["active", "done", "dropped"] },
          note: { type: "string" },
          includeClosed: { type: "boolean", default: false },
        },
      },
    );

    node.tool(
      "mc_map",
      "登记、删除或列出世界地点标记（最多 24 处，读回带方位与距离）",
      (args) => {
        const action = String(args.action ?? "list");
        const cur = this.bot?.entity ? this.currentPos() : undefined;
        const dim = this.bot?.game ? String(this.bot.game.dimension) : "overworld";
        if (action === "set") {
          const pos = Array.isArray(args.position)
            ? (args.position as [number, number, number])
            : cur ?? [0, 64, 0];
          const mark = this.marks.set(
            String(args.name ?? ""),
            pos,
            typeof args.dimension === "string" ? args.dimension : dim,
            typeof args.note === "string" ? args.note : undefined,
          );
          return { mark };
        }
        if (action === "delete") {
          return { deleted: this.marks.delete(String(args.name ?? "")) };
        }
        return { marks: this.marks.list(cur, dim) };
      },
      {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "set", "delete"], default: "list" },
          name: { type: "string" },
          position: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
          dimension: { type: "string" },
          note: { type: "string" },
        },
      },
    );

    node.tool(
      "mc_blueprint",
      "设计、载入、列出或丢弃建筑蓝图",
      (args) => {
        const action = String(args.action ?? "list");
        if (action === "save" || action === "design") {
          return this.blueprints.save({
            name: String(args.name ?? ""),
            size_xyz: args.size_xyz as [number, number, number],
            layers: args.layers as string[][][],
            ...(Array.isArray(args.origin) ? { origin: args.origin as PositionXYZ } : {}),
          });
        }
        if (action === "load") {
          const bp = this.blueprints.load(
            String(args.name ?? ""),
            Array.isArray(args.origin) ? (args.origin as PositionXYZ) : undefined,
          );
          return { loaded: bp.name, size_xyz: bp.size_xyz, origin: bp.origin ?? null };
        }
        if (action === "drop") {
          return { dropped: this.blueprints.drop(typeof args.name === "string" ? args.name : undefined) };
        }
        return { current: this.blueprints.current()?.name ?? null, blueprints: this.blueprints.list() };
      },
      {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "save", "design", "load", "drop"], default: "list" },
          name: { type: "string" },
          size_xyz: { type: "array", items: { type: "integer" }, minItems: 3, maxItems: 3 },
          layers: { type: "array" },
          origin: { type: "array", items: { type: "integer" }, minItems: 3, maxItems: 3 },
        },
      },
    );

    node.tool(
      "mc_check",
      "对世界提交一组断言（block/inventory/position/health/blueprint），只返回未成立的条目",
      (args) => {
        const bot = this.onlineBot();
        const assertions = Array.isArray(args.assertions) ? (args.assertions as CheckAssertion[]) : [];
        return evaluateChecks(bot, this.blueprints.current(), assertions);
      },
      {
        type: "object",
        required: ["assertions"],
        properties: { assertions: { type: "array", items: { type: "object" } } },
      },
    );

    node.tool(
      "mc_view_map",
      "查看背包中携带的游戏内地图物品（编号与基础信息）",
      () => {
        const bot = this.onlineBot();
        const maps = bot.inventory
          .items()
          .filter((it) => it.name === "filled_map")
          .map((it) => ({ slot: it.slot, count: it.count, nbt: it.nbt ?? null }));
        return { count: maps.length, maps };
      },
      { type: "object", additionalProperties: false, properties: {} },
    );

    node.tool(
      "mc_bag",
      "读取当前背包内容与手持物品",
      () => {
        const bot = this.onlineBot();
        return {
          held: bot.heldItem ? { name: bot.heldItem.name, count: bot.heldItem.count } : null,
          items: inventorySummary(bot),
          freeSlots: 36 - bot.inventory.items().length,
        };
      },
      { type: "object", additionalProperties: false, properties: {} },
    );

    node.tool(
      "mc_queue",
      "读取当前工作队列（正在执行的任务、排队任务与近期任务）",
      () => this.executor.queueSnapshot(),
      { type: "object", additionalProperties: false, properties: {} },
    );

    node.tool(
      "mc_blocked",
      "读取最近失败/受阻的步骤及原因",
      () => ({ blocked: this.executor.blockedSnapshot() }),
      { type: "object", additionalProperties: false, properties: {} },
    );

    node.tool(
      "mc_stop",
      "清空工作队列并中止当前任务",
      () => this.executor.stopAll("mc_stop 请求停止"),
      { type: "object", additionalProperties: false, properties: {} },
    );

    node.tool(
      "mc_escape",
      "紧急脱困：清空队列并向服务器发送 /tp 到指定安全坐标或登记的 home 地点",
      (args) => {
        const bot = this.onlineBot();
        const stopped = this.executor.stopAll("mc_escape 脱困");
        let target: [number, number, number] | null = null;
        if (Array.isArray(args.position) && args.position.length === 3) {
          target = [Number(args.position[0]), Number(args.position[1]), Number(args.position[2])];
        } else {
          const home = this.marks.get(typeof args.mark === "string" ? args.mark : "home");
          if (home) target = home.position;
        }
        if (target) {
          bot.chat(`/tp ${bot.username} ${target[0]} ${target[1]} ${target[2]}`);
        } else {
          bot.chat("/kill");
        }
        return { escaped: true, target, ...stopped };
      },
      {
        type: "object",
        properties: {
          mark: { type: "string" },
          position: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
        },
      },
    );

    // ── 兼容 msp-test 的 4 个工具 ──────────────────────────────────────
    node.tool("mc_status", "读取 Minecraft 连接状态", () => ({
      phase: this.phase,
      ...(this.reason ? { reason: this.reason } : {}),
    }));

    node.tool(
      "mc_observe",
      "观测当前坐标、状态、背包与周围方块/实体",
      (args) => {
        const radius = typeof args.radius === "number" ? args.radius : 8;
        return snapshotFromBot(this.onlineBot(), radius) as unknown as Record<string, unknown>;
      },
      { type: "object", properties: { radius: { type: "integer", minimum: 1, maximum: 16, default: 8 } } },
    );

    node.tool(
      "mc_block",
      "查询 32 格以内指定坐标的方块名与属性",
      (args) => {
        const bot = this.onlineBot();
        const pos = args.position as [number, number, number];
        const v = new Vec3(pos[0], pos[1], pos[2]);
        if (bot.entity.position.distanceTo(v) > 32) throw new Error("目标方块超过 32 格");
        const blk = bot.blockAt(v);
        return blk ? { loaded: true, name: blk.name, properties: blk.getProperties() } : { loaded: false };
      },
      {
        type: "object",
        required: ["position"],
        properties: { position: { type: "array", items: { type: "integer" }, minItems: 3, maxItems: 3 } },
      },
    );

    node.tool(
      "mc_say",
      "发送一行普通聊天（拒绝斜杠命令）",
      (args) => {
        const bot = this.onlineBot();
        const text = String(args.text ?? "");
        if (!text.trim() || text.length > 240 || /[\r\n\u0000]/u.test(text) || text.trimStart().startsWith("/")) {
          throw new Error("请提供 1–240 字符的单行普通聊天，不允许斜杠命令");
        }
        bot.chat(text);
        return { sent: true };
      },
      { type: "object", required: ["text"], properties: { text: { type: "string" } } },
    );

    node.skill({
      name: "safe_task_workflow",
      summary: "先试跑评估再排队执行，必要时查队列或紧急止损",
      whenToUse: "执行复杂寻路、挖矿、合成或建造前使用，避免直接卡死或浪费材料",
      toolsUsed: ["mc_observe", "mc_scout", "mc_do", "mc_queue", "mc_check", "mc_stop"],
    });

    node.skill({
      name: "blueprint_build",
      summary: "保存并载入体素蓝图后再施工，完成后用断言核对",
      whenToUse: "需要按精确坐标建造房屋或红石机关时使用",
      toolsUsed: ["mc_blueprint", "mc_bag", "mc_do", "mc_check"],
    });
  }

  start(): void {
    this.stopping = false;
    this.connect();
    this.tickTimer = setInterval(() => {
      void this.onTick();
    }, this.cfg.worldTickMs);
    this.tickTimer.unref?.();
  }

  stop(): void {
    this.stopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.executor.stopAll("World 停止");
    try {
      this.bot?.end();
    } catch {
      /* ignore */
    }
    this.bot = null;
    this.transition("offline", "stopped");
  }

  private onlineBot(): Bot {
    if (this.phase !== "online" || !this.bot?.entity) {
      throw new Error("Minecraft 当前未在线");
    }
    return this.bot;
  }

  private currentPos(): [number, number, number] {
    const p = this.bot!.entity.position;
    return [Math.round(p.x), Math.round(p.y), Math.round(p.z)];
  }

  private transition(phase: "offline" | "connecting" | "online", reason?: string): void {
    this.phase = phase;
    this.reason = reason;
    this.node?.publish("minecraft.connection", { phase, ...(reason ? { reason } : {}) });
  }

  private connect(): void {
    if (this.stopping) return;
    this.transition("connecting");
    const bot = mineflayer.createBot({
      host: this.cfg.host,
      port: this.cfg.port,
      username: this.cfg.username,
      version: this.cfg.version,
      auth: this.cfg.auth,
      hideErrors: true,
    });
    this.bot = bot;
    bot.loadPlugin(pathfinder);
    let failure: string | undefined;

    bot.on("spawn", () => {
      this.transition("online");
      this.node?.publish("minecraft.event", { kind: "spawn", position: this.currentPos() });
    });

    bot.on("chat", (sender, text) => {
      if (sender !== bot.username) {
        this.node?.publish("minecraft.chat", { sender, text });
      }
    });

    bot.on("health", () => {
      this.node?.publish("minecraft.event", { kind: "health", health: bot.health, food: bot.food });
      void this.executor.runReflexTick();
    });

    bot.on("death", () => {
      this.executor.stopAll("角色死亡");
      this.transition("connecting", "Respawning");
      this.node?.publish("minecraft.event", { kind: "death" });
    });

    bot.on("error", (err) => {
      failure = err.message;
    });

    bot.on("kicked", (reason) => {
      failure = typeof reason === "string" ? reason : JSON.stringify(reason);
    });

    bot.once("end", (reason) => {
      if (this.stopping) return;
      this.executor.stopAll("连接断开");
      this.transition("offline", failure || String(reason));
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, 2000);
      this.reconnectTimer.unref?.();
    });
  }

  private async onTick(): Promise<void> {
    if (this.phase !== "online" || !this.bot?.entity) return;
    await this.executor.runReflexTick();

    const snap = snapshotFromBot(this.bot, 8);
    const delta = worldDelta(this.lastWorldSnap, snap, this.cfg.moveThreshold);
    if (delta) {
      this.node?.publish("minecraft.world", delta);
    }
    this.lastWorldSnap = snap;

    const now = Date.now();
    if (now - this.lastSnapshotAt >= this.cfg.snapshotIntervalMs) {
      this.lastSnapshotAt = now;
      this.node?.publish("minecraft.world.snapshot", {
        world: snap,
        queue: this.executor.queueSnapshot(),
        goals: this.goals.list(),
        marks: this.marks.list(snap.position, snap.dimension),
      });
    }
  }
}
