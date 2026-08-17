import { describe, expect, it } from "vitest";
import { cancelRun, recoverExpiredLeases } from "../src/cancel.js";

function makeClient(rowsByCall: unknown[][]) {
  let call = 0;
  return {
    async query(_sql: string) {
      const rows = rowsByCall[call] ?? [];
      call += 1;
      return { rows };
    },
  };
}

describe("cancelRun(阶段 F)", () => {
  it("非 terminal → cancelled + generation+1(生效)", async () => {
    const client = makeClient([[{ id: "run-1" }]]);
    const ok = await cancelRun({ client: client as never, runId: "run-1" });
    expect(ok).toBe(true);
  });

  it("已 terminal → 0 行(幂等 no-op)", async () => {
    const client = makeClient([[]]);
    const ok = await cancelRun({ client: client as never, runId: "run-1" });
    expect(ok).toBe(false);
  });
});

describe("recoverExpiredLeases(阶段 E:zombie recovery)", () => {
  it("有步骤 → interrupted;无步骤 → failed", async () => {
    const client = makeClient([[{ id: "r1" }], [{ id: "r2" }]]);
    const res = await recoverExpiredLeases(client as never);
    expect(res.interrupted).toBe(1);
    expect(res.failed).toBe(1);
  });

  it("无过期任务 → 0/0", async () => {
    const client = makeClient([[], []]);
    const res = await recoverExpiredLeases(client as never);
    expect(res).toEqual({ interrupted: 0, failed: 0 });
  });
});
