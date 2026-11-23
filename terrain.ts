/**
 * 世界观测、方位计算、危险检测与增量对比（对齐 Cortico minecraft/terrain.ts）。
 */
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";

export interface WorldSnapshot {
  position: [number, number, number];
  dimension: string;
  health: number;
  food: number;
  oxygen: number;
  isDay: boolean;
  isRaining: boolean;
  inventory: Array<{ name: string; count: number; slot: number }>;
  nearbyBlocks: Array<{ name: string; position: [number, number, number]; distance: number }>;
  nearbyEntities: Array<{ name: string; type: string; position: [number, number, number]; distance: number; direction: string }>;
}

const NOTABLE_BLOCKS = new Set([
  "oak_log", "birch_log", "spruce_log", "jungle_log", "acacia_log", "dark_oak_log",
  "crafting_table", "furnace", "blast_furnace", "smoker", "chest", "trapped_chest", "barrel",
  "coal_ore", "iron_ore", "gold_ore", "diamond_ore", "copper_ore", "redstone_ore", "lapis_ore", "emerald_ore",
  "deepslate_coal_ore", "deepslate_iron_ore", "deepslate_diamond_ore",
  "lava", "water", "fire", "torch", "wheat", "carrots", "potatoes",
]);

export function bearing(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
): { distance: number; direction: string } {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const distance = Number(Math.sqrt(dx * dx + dy * dy + dz * dz).toFixed(1));
  const horiz = Math.hypot(dx, dz);
  if (horiz < 0.5) {
    return { distance, direction: dy > 0.5 ? "上方" : dy < -0.5 ? "下方" : "脚下" };
  }
  const angle = Math.atan2(dz, dx) * (180 / Math.PI);
  // MC: +X = 东, +Z = 南, -X = 西, -Z = 北
  const dirs = ["东", "东南", "南", "西南", "西", "西北", "北", "东北"];
  const idx = Math.round(((angle % 360) + 360) % 360 / 45) % 8;
  return { distance, direction: dirs[idx] };
}

export function inventorySummary(bot: Bot): Array<{ name: string; count: number; slot: number }> {
  return bot.inventory.items().map((item) => ({
    name: item.name,
    count: item.count,
    slot: item.slot,
  }));
}

export function snapshotFromBot(bot: Bot, radius = 8): WorldSnapshot {
  const pos = bot.entity.position;
  const origin: [number, number, number] = [
    Math.floor(pos.x),
    Math.floor(pos.y),
    Math.floor(pos.z),
  ];

  const nearbyBlocks: WorldSnapshot["nearbyBlocks"] = [];
  const r = Math.min(Math.max(1, radius), 16);
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dz = -r; dz <= r; dz++) {
        const p = new Vec3(origin[0] + dx, origin[1] + dy, origin[2] + dz);
        const block = bot.blockAt(p);
        if (!block) continue;
        if (NOTABLE_BLOCKS.has(block.name) || block.name.endsWith("_bed")) {
          nearbyBlocks.push({
            name: block.name,
            position: [p.x, p.y, p.z],
            distance: Number(pos.distanceTo(p).toFixed(1)),
          });
        }
      }
    }
  }
  nearbyBlocks.sort((a, b) => a.distance - b.distance);

  const nearbyEntities: WorldSnapshot["nearbyEntities"] = [];
  for (const entity of Object.values(bot.entities)) {
    if (!entity || entity === bot.entity) continue;
    const dist = pos.distanceTo(entity.position);
    if (dist > r * 2) continue;
    const ep: [number, number, number] = [
      Math.round(entity.position.x),
      Math.round(entity.position.y),
      Math.round(entity.position.z),
    ];
    const b = bearing(origin, ep);
    nearbyEntities.push({
      name: entity.username ?? entity.name ?? entity.displayName ?? "unknown",
      type: entity.type ?? "unknown",
      position: ep,
      distance: b.distance,
      direction: b.direction,
    });
  }
  nearbyEntities.sort((a, b) => a.distance - b.distance);

  const timeOfDay = bot.time?.timeOfDay ?? 0;
  return {
    position: origin,
    dimension: String(bot.game?.dimension ?? "overworld"),
    health: Math.round(bot.health ?? 20),
    food: Math.round(bot.food ?? 20),
    oxygen: Math.round(bot.oxygenLevel ?? 20),
    isDay: timeOfDay < 12500 || timeOfDay > 23500,
    isRaining: Boolean(bot.isRaining),
    inventory: inventorySummary(bot),
    nearbyBlocks: nearbyBlocks.slice(0, 32),
    nearbyEntities: nearbyEntities.slice(0, 24),
  };
}

export function hazardTouch(bot: Bot): "lava" | "drown" | null {
  const pos = bot.entity?.position;
  if (!pos) return null;
  const feet = bot.blockAt(pos.floored());
  const head = bot.blockAt(pos.offset(0, 1, 0).floored());
  if (feet?.name === "lava" || head?.name === "lava" || feet?.name === "fire") {
    return "lava";
  }
  if ((bot.oxygenLevel ?? 20) < 10 && head?.name === "water") {
    return "drown";
  }
  return null;
}

export function worldDelta(
  prev: WorldSnapshot | null,
  next: WorldSnapshot,
  moveThreshold = 12,
): Record<string, unknown> | null {
  if (!prev) return null;
  const dist = Math.hypot(
    next.position[0] - prev.position[0],
    next.position[1] - prev.position[1],
    next.position[2] - prev.position[2],
  );
  const delta: Record<string, unknown> = {};
  if (prev.dimension !== next.dimension) delta.dimension = { from: prev.dimension, to: next.dimension };
  if (dist >= moveThreshold) delta.moved = { from: prev.position, to: next.position, distance: Math.round(dist) };
  if (prev.isDay !== next.isDay) delta.isDay = next.isDay;
  if (prev.isRaining !== next.isRaining) delta.isRaining = next.isRaining;
  if (Math.abs(prev.health - next.health) >= 2) delta.health = { from: prev.health, to: next.health };
  return Object.keys(delta).length > 0 ? delta : null;
}
