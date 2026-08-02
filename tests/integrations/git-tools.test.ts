import { describe, expect, it, vi } from "vitest";

/**
 * Git 工具的护栏。
 *
 * 这套工具让模型能改用户**已有的代码**,风险等级和工作区完全不同 ——
 * 工作区写错了删掉重来,仓库写错了可能覆盖真实项目。
 *
 * 所以两条硬规则必须在**代码层**保证,而不是只写进提示词:
 *   1. 只能碰用户在 GitHub 上授权过的仓库
 *   2. 绝不直接写默认分支 —— 一律走分支 + PR,让人在合并前看到 diff
 *
 * 提示词是建议,代码才是保证。
 */

vi.mock("server-only", () => ({}));

const calls: string[] = [];

vi.mock("@/lib/integrations/github", () => ({
  parseRepo: (full: string) => {
    const [owner, repo] = full.split("/");
    return owner && repo ? { owner, repo } : null;
  },
  listRepoFiles: async () => {
    calls.push("list");
    return { ok: true, entries: [{ path: "src/a.ts", type: "file", size: 10 }] };
  },
  readRepoFile: async () => {
    calls.push("read");
    return { ok: true, file: { path: "src/a.ts", content: "内容", sha: "s" } };
  },
  commitFiles: async () => {
    calls.push("commit");
    return { ok: true, commitSha: "abcdef1234" };
  },
  openPullRequest: async () => {
    calls.push("pr");
    return { ok: true, pr: { number: 7, url: "https://github.com/o/r/pull/7" } };
  },
}));

const CTX = {
  installationId: "1",
  allowedRepos: ["me/app"],
  defaultBranches: { "me/app": "main" },
};

function call(name: string, args: unknown) {
  return { id: "c1", name, rawArguments: JSON.stringify(args) };
}

describe("仓库白名单", () => {
  it("未授权的仓库一律拒绝,并列出可用的", async () => {
    const { executeGitTool } = await import("@/lib/ai/git-tools");
    const r = await executeGitTool(
      call("git_read_file", { repo: "someone/private", path: "a.ts" }),
      CTX,
    );
    expect(r.ok).toBe(false);
    expect(r.content).toContain("不在授权范围");
    expect(r.content).toContain("me/app");
  });

  it("授权过的仓库可以读", async () => {
    const { executeGitTool } = await import("@/lib/ai/git-tools");
    const r = await executeGitTool(
      call("git_read_file", { repo: "me/app", path: "src/a.ts" }),
      CTX,
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("内容");
  });
});

describe("默认分支写保护", () => {
  it("直接写 main 被拒绝,且没有发起任何提交", async () => {
    calls.length = 0;
    const { executeGitTool } = await import("@/lib/ai/git-tools");
    const r = await executeGitTool(
      call("git_propose_changes", {
        repo: "me/app",
        branch: "main",
        title: "改点东西",
        files: [{ path: "a.ts", content: "x" }],
      }),
      CTX,
    );

    expect(r.ok).toBe(false);
    expect(r.content).toContain("不能直接提交到默认分支");
    // 关键:必须在**发起提交之前**就拦下
    expect(calls).not.toContain("commit");
  });

  it("走新分支时提交并开 PR,且明确说明尚未合并", async () => {
    calls.length = 0;
    const { executeGitTool } = await import("@/lib/ai/git-tools");
    const r = await executeGitTool(
      call("git_propose_changes", {
        repo: "me/app",
        branch: "zhiyi/fix-login",
        title: "修复登录重定向",
        body: "说明",
        files: [{ path: "a.ts", content: "x" }],
      }),
      CTX,
    );

    expect(r.ok).toBe(true);
    expect(calls).toEqual(["commit", "pr"]);
    expect(r.content).toContain("pull/7");
    // 绝不能让用户以为已经合并了
    expect(r.content).toContain("尚未合并");
  });
});

describe("已有分支不得被快进", () => {
  it("分支已存在时拒绝,不去改它", async () => {
    calls.length = 0;
    vi.resetModules();
    vi.doMock("@/lib/integrations/github", () => ({
      parseRepo: (full: string) => {
        const [owner, repo] = full.split("/");
        return owner && repo ? { owner, repo } : null;
      },
      commitFiles: async () => {
        calls.push("commit");
        return { ok: false, error: "分支 staging 已存在。请换一个分支名重试。" };
      },
      openPullRequest: async () => {
        calls.push("pr");
        return { ok: true, pr: { number: 1, url: "u" } };
      },
      listRepoFiles: async () => ({ ok: true, entries: [] }),
      readRepoFile: async () => ({ ok: false, error: "x" }),
    }));

    const { executeGitTool } = await import("@/lib/ai/git-tools");
    const r = await executeGitTool(
      call("git_propose_changes", {
        repo: "me/app",
        branch: "staging",
        title: "t",
        files: [{ path: "a.ts", content: "x" }],
      }),
      CTX,
    );

    expect(r.ok).toBe(false);
    expect(r.content).toContain("已存在");
    // 提交失败后绝不能继续开 PR —— 那会让用户以为改动已经提上去了
    expect(calls).not.toContain("pr");
    vi.doUnmock("@/lib/integrations/github");
  });
});

describe("参数校验", () => {
  it("路径穿越被拒绝", async () => {
    const { executeGitTool } = await import("@/lib/ai/git-tools");
    const r = await executeGitTool(
      call("git_read_file", { repo: "me/app", path: "../../etc/passwd" }),
      CTX,
    );
    expect(r.ok).toBe(false);
    expect(r.content).toContain("..");
  });

  it("非法分支名被拒绝", async () => {
    const { executeGitTool } = await import("@/lib/ai/git-tools");
    const r = await executeGitTool(
      call("git_propose_changes", {
        repo: "me/app",
        branch: "a..b",
        title: "t",
        files: [{ path: "a.ts", content: "x" }],
      }),
      CTX,
    );
    expect(r.ok).toBe(false);
  });

  it("非法 JSON 不抛错,而是回喂给模型让它改正", async () => {
    const { executeGitTool } = await import("@/lib/ai/git-tools");
    const r = await executeGitTool(
      { id: "c", name: "git_read_file", rawArguments: "{坏的" },
      CTX,
    );
    expect(r.ok).toBe(false);
    expect(r.content).toContain("合法的 JSON");
  });
});
