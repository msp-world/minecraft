/**
 * mc_policy —— 常驻规矩（对齐 Cortico minecraft/policy.ts）。
 */

export type TravelPrefer = "auto" | "dig" | "place";
export type LightWhen = "dig" | "anywhere";
export type FightMode = "auto" | "armed" | "off";

export interface PolicySettings {
  scaffold: string[];
  light: string[];
  lightWhen: LightWhen;
  travel: TravelPrefer;
  reserve: string[];
  fight: FightMode;
  fleeHealth: number;
  antiLava: boolean;
  antiDrown: boolean;
}

export function defaultPolicy(): PolicySettings {
  return {
    scaffold: ["dirt", "cobblestone"],
    light: ["torch"],
    lightWhen: "dig",
    travel: "auto",
    reserve: [],
    fight: "armed",
    fleeHealth: 8,
    antiLava: true,
    antiDrown: true,
  };
}

export function isSpawnAnchorBlock(name: string): boolean {
  return name === "respawn_anchor" || /(^|_)bed$/.test(name);
}

export function isGravityBlock(name: string): boolean {
  return (
    name === "sand" ||
    name === "red_sand" ||
    name === "gravel" ||
    name === "suspicious_sand" ||
    name === "suspicious_gravel" ||
    name === "anvil" ||
    name === "chipped_anvil" ||
    name === "damaged_anvil" ||
    name === "dragon_egg" ||
    name === "pointed_dripstone" ||
    name.endsWith("_concrete_powder")
  );
}

export function applyPolicyPatch(
  current: PolicySettings,
  patch: Record<string, unknown>,
): { next: PolicySettings; notes: string[] } {
  const next: PolicySettings = {
    ...current,
    scaffold: [...current.scaffold],
    light: [...current.light],
    reserve: [...current.reserve],
  };
  const notes: string[] = [];

  if (patch.scaffold !== undefined) {
    if (Array.isArray(patch.scaffold) && patch.scaffold.every((x) => typeof x === "string")) {
      const filtered = patch.scaffold.map((s) => s.trim()).filter(Boolean);
      const dropped = filtered.filter((s) => isGravityBlock(s) || isSpawnAnchorBlock(s));
      if (dropped.length > 0) notes.push(`scaffold 排除重力/重生方块: ${dropped.join(", ")}`);
      next.scaffold = filtered.filter((s) => !isGravityBlock(s) && !isSpawnAnchorBlock(s));
    } else {
      notes.push("scaffold 必须是字符串数组，已忽略");
    }
  }

  if (patch.light !== undefined) {
    if (Array.isArray(patch.light) && patch.light.every((x) => typeof x === "string")) {
      next.light = patch.light.map((s) => s.trim()).filter(Boolean);
    } else {
      notes.push("light 必须是字符串数组，已忽略");
    }
  }

  if (patch.lightWhen !== undefined) {
    if (patch.lightWhen === "dig" || patch.lightWhen === "anywhere") next.lightWhen = patch.lightWhen;
    else notes.push("lightWhen 仅支持 dig / anywhere，已忽略");
  }

  if (patch.travel !== undefined) {
    if (patch.travel === "auto" || patch.travel === "dig" || patch.travel === "place") {
      next.travel = patch.travel;
    } else {
      notes.push("travel 仅支持 auto / dig / place，已忽略");
    }
  }

  if (patch.reserve !== undefined) {
    if (Array.isArray(patch.reserve) && patch.reserve.every((x) => typeof x === "string")) {
      next.reserve = patch.reserve.map((s) => s.trim()).filter(Boolean);
    } else {
      notes.push("reserve 必须是字符串数组，已忽略");
    }
  }

  if (patch.fight !== undefined) {
    if (patch.fight === "auto" || patch.fight === "armed" || patch.fight === "off") {
      next.fight = patch.fight;
    } else {
      notes.push("fight 仅支持 auto / armed / off，已忽略");
    }
  }

  if (patch.fleeHealth !== undefined) {
    const n = Number(patch.fleeHealth);
    if (Number.isFinite(n) && n >= 0 && n <= 20) next.fleeHealth = n;
    else notes.push("fleeHealth 需在 0–20 之间，已忽略");
  }

  if (typeof patch.antiLava === "boolean") next.antiLava = patch.antiLava;
  if (typeof patch.antiDrown === "boolean") next.antiDrown = patch.antiDrown;

  return { next, notes };
}
