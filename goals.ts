/**
 * mc_goal —— 世界目标跟踪（最多 5 个活跃目标）。
 */

export type GoalStatus = "active" | "done" | "dropped";

export interface McGoal {
  id: string;
  title: string;
  status: GoalStatus;
  note?: string;
  updatedAt: string;
}

const MAX_ACTIVE_GOALS = 5;

export class GoalBook {
  private readonly goals = new Map<string, McGoal>();
  private seq = 1;

  add(title: string, note?: string): McGoal {
    const activeCount = [...this.goals.values()].filter((g) => g.status === "active").length;
    if (activeCount >= MAX_ACTIVE_GOALS) {
      throw new Error(`最多同时跟踪 ${MAX_ACTIVE_GOALS} 个活跃目标`);
    }
    const id = `g${this.seq++}`;
    const goal: McGoal = {
      id,
      title: title.trim(),
      status: "active",
      ...(note ? { note } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.goals.set(id, goal);
    return goal;
  }

  update(id: string, status: GoalStatus, note?: string): McGoal {
    const g = this.goals.get(id);
    if (!g) throw new Error(`未找到目标: ${id}`);
    g.status = status;
    if (note !== undefined) g.note = note;
    g.updatedAt = new Date().toISOString();
    return g;
  }

  list(includeClosed = false): McGoal[] {
    const all = [...this.goals.values()];
    return includeClosed ? all : all.filter((g) => g.status === "active");
  }
}
