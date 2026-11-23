/**
 * mc_blueprint —— 建筑与机关蓝图（设计、载入、清单、进度核对）。
 */

export type PositionXYZ = [number, number, number];
export type SizeXYZ = [number, number, number];

export interface BlueprintDef {
  name: string;
  size_xyz: SizeXYZ;
  /** layers[y][z][x] 方块名（如 "oak_planks" 或 "air"） */
  layers: string[][][];
  origin?: PositionXYZ;
}

export interface BlueprintBillItem {
  block: string;
  count: number;
}

export class BlueprintBook {
  private readonly saved = new Map<string, BlueprintDef>();
  private loadedName: string | null = null;

  save(def: BlueprintDef): { blueprint: BlueprintDef; bill: BlueprintBillItem[] } {
    const name = def.name.trim();
    if (!name) throw new Error("蓝图名称不能为空");
    const [sx, sy, sz] = def.size_xyz;
    if (!Number.isInteger(sx) || !Number.isInteger(sy) || !Number.isInteger(sz) || sx <= 0 || sy <= 0 || sz <= 0) {
      throw new Error("size_xyz 必须是正整数 [X, Y, Z]");
    }
    if (!Array.isArray(def.layers) || def.layers.length !== sy) {
      throw new Error(`layers 高度 (${def.layers?.length ?? 0}) 与 size_xyz[1] (${sy}) 不匹配`);
    }
    const counts = new Map<string, number>();
    const layers: string[][][] = [];
    for (let y = 0; y < sy; y++) {
      const slice = def.layers[y];
      if (!Array.isArray(slice) || slice.length !== sz) {
        throw new Error(`layers[${y}] 深度与 size_xyz[2] (${sz}) 不匹配`);
      }
      const outSlice: string[][] = [];
      for (let z = 0; z < sz; z++) {
        const row = slice[z];
        if (!Array.isArray(row) || row.length !== sx) {
          throw new Error(`layers[${y}][${z}] 宽度与 size_xyz[0] (${sx}) 不匹配`);
        }
        const outRow = row.map((b) => String(b).replace(/^minecraft:/, "").trim() || "air");
        for (const b of outRow) {
          if (b !== "air" && b !== "structure_void") {
            counts.set(b, (counts.get(b) ?? 0) + 1);
          }
        }
        outSlice.push(outRow);
      }
      layers.push(outSlice);
    }

    const stored: BlueprintDef = {
      name,
      size_xyz: [sx, sy, sz],
      layers,
      ...(def.origin ? { origin: def.origin } : {}),
    };
    this.saved.set(name, stored);
    this.loadedName = name;

    const bill = [...counts.entries()]
      .map(([block, count]) => ({ block, count }))
      .sort((a, b) => b.count - a.count);
    return { blueprint: stored, bill };
  }

  load(name: string, origin?: PositionXYZ): BlueprintDef {
    const bp = this.saved.get(name.trim());
    if (!bp) throw new Error(`未找到蓝图: ${name}`);
    if (origin) bp.origin = origin;
    this.loadedName = bp.name;
    return bp;
  }

  drop(name?: string): boolean {
    const target = name?.trim() || this.loadedName;
    if (!target) return false;
    if (this.loadedName === target) this.loadedName = null;
    return this.saved.delete(target);
  }

  current(): BlueprintDef | null {
    return this.loadedName ? this.saved.get(this.loadedName) ?? null : null;
  }

  list(): Array<{ name: string; size_xyz: SizeXYZ; loaded: boolean; origin?: PositionXYZ }> {
    return [...this.saved.values()].map((b) => ({
      name: b.name,
      size_xyz: b.size_xyz,
      loaded: b.name === this.loadedName,
      ...(b.origin ? { origin: b.origin } : {}),
    }));
  }
}
