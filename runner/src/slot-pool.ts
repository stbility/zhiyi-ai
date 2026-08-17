/**
 * Slot pool —— Runner 进程内并发上限(Phase 2.2 D21)。
 *
 * 每个槽位同一时刻至多执行一个 run;实际并发数 = min(Σ槽位, 商业上限),
 * 商业上限由数据库 checkConcurrentTasks 强制(Runner 领取后 status=running
 * 天然被计入)。槽位只是工程层上限,防止单 Runner 过载。
 */

export class SlotPool {
  private busy = 0;
  private readonly capacity: number;

  constructor(capacity: number) {
    if (capacity < 1) throw new Error("capacity must be >= 1");
    this.capacity = capacity;
  }

  /** 是否有空闲槽位 */
  hasFreeSlot(): boolean {
    return this.busy < this.capacity;
  }

  /** 占用一个槽位。调用方必须在 finally 中 release。 */
  acquire(): void {
    if (!this.hasFreeSlot()) {
      throw new Error("no free slot");
    }
    this.busy += 1;
  }

  /** 释放槽位。 */
  release(): void {
    this.busy = Math.max(0, this.busy - 1);
  }

  get busyCount(): number {
    return this.busy;
  }

  get capacityValue(): number {
    return this.capacity;
  }

  /** 健康检查用:当前占用/容量 */
  status(): { total: number; busy: number } {
    return { total: this.capacity, busy: this.busy };
  }
}
