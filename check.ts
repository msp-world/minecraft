/**
 * mc_check —— 对世界提交一组断言，只返回与事实不符的条目。
 */
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { BlueprintDef } from "./blueprint.ts";

export type CheckAssertion =
  | { type: "block"; position: [number, number, number]; is: string }
  | { type: "inventory"; item: string; min?: number; max?: number }
  | { type: "position"; within: [number, number, number]; radius: number }
  | { type: "health"; min: number }
  | { type: "blueprint"; name?: string };

export interface FailedAssertion {
  index: number;
  assertion: CheckAssertion;
  actual: string;
}

export function evaluateChecks(
  bot: Bot,
  blueprint: BlueprintDef | null,
  assertions: readonly CheckAssertion[],
): { passed: number; failed: FailedAssertion[] } {
  const failed: FailedAssertion[] = [];
  let passed = 0;

  for (let i = 0; i < assertions.length; i++) {
    const a = assertions[i];
    if (a.type === "block") {
      const p = new Vec3(a.position[0], a.position[1], a.position[2]);
      const blk = bot.blockAt(p);
      const want = a.is.replace(/^minecraft:/, "");
      if (!blk) {
        failed.push({ index: i, assertion: a, actual: "区块未加载" });
      } else if (blk.name !== want) {
        failed.push({ index: i, assertion: a, actual: `实际方块为 ${blk.name}` });
      } else {
        passed++;
      }
    } else if (a.type === "inventory") {
      const want = a.item.replace(/^minecraft:/, "");
      const count = bot.inventory
        .items()
        .filter((it) => it.name === want || it.name.endsWith(`_${want}`))
        .reduce((s, it) => s + it.count, 0);
      const minOk = a.min === undefined || count >= a.min;
      const maxOk = a.max === undefined || count <= a.max;
      if (!minOk || !maxOk) {
        failed.push({ index: i, assertion: a, actual: `背包中 ${want} 实际数量为 ${count}` });
      } else {
        passed++;
      }
    } else if (a.type === "position") {
      const target = new Vec3(a.within[0], a.within[1], a.within[2]);
      const dist = bot.entity.position.distanceTo(target);
      if (dist > a.radius) {
        failed.push({ index: i, assertion: a, actual: `当前距离目标 ${dist.toFixed(1)} 格 (> ${a.radius})` });
      } else {
        passed++;
      }
    } else if (a.type === "health") {
      const hp = bot.health ?? 20;
      if (hp < a.min) {
        failed.push({ index: i, assertion: a, actual: `当前生命值 ${hp} (< ${a.min})` });
      } else {
        passed++;
      }
    } else if (a.type === "blueprint") {
      if (!blueprint || !blueprint.origin) {
        failed.push({ index: i, assertion: a, actual: "当前未载入带 origin 的蓝图" });
      } else {
        const [ox, oy, oz] = blueprint.origin;
        let mismatch = 0;
        for (let y = 0; y < blueprint.size_xyz[1]; y++) {
          for (let z = 0; z < blueprint.size_xyz[2]; z++) {
            for (let x = 0; x < blueprint.size_xyz[0]; x++) {
              const want = blueprint.layers[y][z][x];
              if (want === "structure_void") continue;
              const blk = bot.blockAt(new Vec3(ox + x, oy + y, oz + z));
              if (!blk || blk.name !== want) mismatch++;
            }
          }
        }
        if (mismatch > 0) {
          failed.push({ index: i, assertion: a, actual: `蓝图仍有 ${mismatch} 格未匹配` });
        } else {
          passed++;
        }
      }
    }
  }

  return { passed, failed };
}
