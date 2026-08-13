import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * P0-1 人工闸门不跳过被保护步骤(2026-08-13 修复)。
 *
 * 背景:needsInput/needsApproval 步骤命中闸门暂停后,恢复时从
 * pausedIndex + 1 继续 —— 被闸门保护的步骤本身从未执行。
 * state-machine.ts 的语义是「执行到该步骤前停下,等用户批准后才继续」,
 * 即批准后该步骤必须真正执行。
 *
 * 修复要点:
 *   1. executeWorkflowSteps 新增 resolvedGateIndex 参数,命中的步骤不暂停
 *   2. 恢复调用从 pausedIndex(而非 pausedIndex + 1)继续
 *   3. 用户输入只拼给被保护的步骤(startIndex === resolvedGateIndex)
 *   4. 恢复时过滤同 stepId 的闸门占位记录,不留双记录
 */
const ACTIONS = readFileSync(
  resolve(__dirname, "../../src/app/(app)/workflow/actions.ts"),
  "utf8",
);
const EXECUTE = readFileSync(
  resolve(__dirname, "../../src/lib/workflow/execute.ts"),
  "utf8",
);

describe("P0-1 人工闸门恢复执行被保护步骤", () => {
  it("executeWorkflowSteps 新增 resolvedGateIndex 参数(默认 null 兼容旧调用)", () => {
    expect(EXECUTE).toMatch(/resolvedGateIndex: number \| null = null/);
  });

  it("闸门早退条件带上 i !== resolvedGateIndex(恢复时被保护步骤不暂停)", () => {
    expect(EXECUTE).toMatch(/step\.needsInput && i !== resolvedGateIndex/);
    expect(EXECUTE).toMatch(/step\.needsApproval && i !== resolvedGateIndex/);
  });

  it("恢复调用从 pausedIndex 继续,不再 +1 跳过被保护步骤", () => {
    // approveWorkflowStep 与 submitWorkflowInput 两处恢复调用
    const approveCall = ACTIONS.slice(
      ACTIONS.indexOf("export async function approveWorkflowStep"),
      ACTIONS.indexOf("export async function submitWorkflowInput"),
    );
    expect(approveCall).toMatch(/pausedIndex,/);
    expect(approveCall).not.toMatch(/pausedIndex \+ 1/);

    const inputCall = ACTIONS.slice(
      ACTIONS.indexOf("export async function submitWorkflowInput"),
    );
    expect(inputCall).toMatch(/pausedIndex,/);
    expect(inputCall).not.toMatch(/pausedIndex \+ 1/);
  });

  it("用户输入只拼给被闸门保护的那一步(startIndex === resolvedGateIndex)", () => {
    expect(EXECUTE).toMatch(/startIndex === resolvedGateIndex/);
    // 旧的「恢复即拼给每一步」条件已移除
    expect(EXECUTE).not.toMatch(/startIndex > 0 && pendingInput/);
  });

  it("恢复时过滤同 stepId 的闸门占位记录(WAITING_* 双记录防护)", () => {
    expect(EXECUTE).toMatch(/WAITING_FOR_INPUT/);
    expect(EXECUTE).toMatch(/WAITING_FOR_APPROVAL/);
    expect(EXECUTE).toMatch(/s\.stepId === gateStep\.id/);
    expect(EXECUTE).toMatch(/rawSteps\.filter/);
  });

  it("Worker 首次执行路径不受影响(resolvedGateIndex 缺省为 null)", () => {
    // worker route 调用 executeWorkflowSteps 时不传第 7 参,闸门行为保持原样
    expect(EXECUTE).toMatch(/resolvedGateIndex === null/);
  });
});
