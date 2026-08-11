import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const M0043 = readFileSync(
  resolve(__dirname, "../../supabase/migrations/0043_messages_run_id.sql"),
  "utf8",
);

describe("0043 消息↔运行记录关联", () => {
  it("messages 加 run_id 外键 + 索引(续跑跨刷新的数据基础)", () => {
    expect(M0043).toMatch(/add column if not exists run_id uuid references public\.agent_runs\(id\) on delete set null/);
    expect(M0043).toContain("create index if not exists messages_run_id_idx");
  });
});
