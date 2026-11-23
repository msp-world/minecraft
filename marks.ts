/**
 * mc_map —— 世界地点标记簿（最多 24 处，读回带方位与距离）。
 */
import { bearing } from "./terrain.ts";

export interface PlaceMark {
  name: string;
  position: [number, number, number];
  dimension: string;
  note?: string;
  updatedAt: string;
}

const MAX_MARKS = 24;

export class MarkBook {
  private readonly marks = new Map<string, PlaceMark>();

  set(name: string, position: [number, number, number], dimension: string, note?: string): PlaceMark {
    const key = name.trim();
    if (!key) throw new Error("地点名称不能为空");
    if (!this.marks.has(key) && this.marks.size >= MAX_MARKS) {
      throw new Error(`最多只能登记 ${MAX_MARKS} 处地点，请先删除旧地点`);
    }
    const mark: PlaceMark = {
      name: key,
      position: [Math.round(position[0]), Math.round(position[1]), Math.round(position[2])],
      dimension,
      ...(note ? { note } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.marks.set(key, mark);
    return mark;
  }

  delete(name: string): boolean {
    return this.marks.delete(name.trim());
  }

  get(name: string): PlaceMark | undefined {
    return this.marks.get(name.trim());
  }

  list(from?: [number, number, number], currentDimension?: string): Array<PlaceMark & { distance?: number; bearing?: string }> {
    return [...this.marks.values()].map((m) => {
      if (!from || (currentDimension && m.dimension !== currentDimension)) {
        return { ...m };
      }
      const b = bearing(from, m.position);
      return { ...m, distance: b.distance, bearing: b.direction };
    });
  }
}
