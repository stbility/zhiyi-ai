import { describe, expect, it } from "vitest";
import { SlotPool } from "../src/slot-pool.js";

describe("SlotPool", () => {
  it("acquire/release 维护 busy 计数", () => {
    const pool = new SlotPool(2);
    expect(pool.hasFreeSlot()).toBe(true);
    pool.acquire();
    pool.acquire();
    expect(pool.hasFreeSlot()).toBe(false);
    expect(pool.status()).toEqual({ total: 2, busy: 2 });
    pool.release();
    expect(pool.hasFreeSlot()).toBe(true);
  });

  it("超容量 acquire 抛错", () => {
    const pool = new SlotPool(1);
    pool.acquire();
    expect(() => pool.acquire()).toThrow("no free slot");
  });

  it("capacity < 1 拒绝", () => {
    expect(() => new SlotPool(0)).toThrow("capacity must be >= 1");
  });

  it("release 不会低于 0", () => {
    const pool = new SlotPool(1);
    pool.release();
    pool.release();
    expect(pool.busyCount).toBe(0);
  });
});
