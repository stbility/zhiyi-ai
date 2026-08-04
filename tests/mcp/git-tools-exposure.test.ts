import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Git 工具通过 MCP 暴露给外部智能体(Hermes Agent、OpenClaw 等)。
 *
 * 这一步是「让智能体真的能拉代码、改代码、提 PR」的最后一段:
 * 工具本体、执行器、上下文装配早就有了,但 MCP 那边只暴露了工作区四件套,
 * 外部智能体接进来读得到工作区,却碰不到用户的真实项目。
 *
 * Hermes 的接法是官方文档给的(~/.hermes/config.yaml 的 mcp_servers,
 * 远程 HTTP + Authorization 头),与我们已有的 streamable-http 端点对得上,
 * 所以传输层不用动 —— 缺的只是工具清单。
 * 来源:hermes-agent.nousresearch.com/docs/user-guide/features/mcp
 */

const read = (p: string) => readFileSync(resolve(__dirname, "../../", p), "utf8");

const { MCP_GIT_TOOLS, MCP_TOOLS } = await import("@/lib/mcp/tools");
const { GIT_TOOLS } = await import("@/lib/ai/git-tools");

describe("定义只有一份", () => {
  /**
   * MCP 侧不重写 JSON Schema,直接从 GIT_TOOLS 转译。
   *
   * 写两份的话,参数说明、必填项、边界值迟早对不上 —— 而这些工具决定的是
   * 「哪些仓库能碰」「能不能直接写 main」,对不上就是安全问题。
   */
  it("每个内部 Git 工具都有对应的 MCP 工具", () => {
    expect(MCP_GIT_TOOLS).toHaveLength(GIT_TOOLS.length);
    for (const t of GIT_TOOLS) {
      const 对应 = MCP_GIT_TOOLS.find(
        (m) => m.name === `zhiyi_${t.function.name}`,
      );
      expect(对应, `${t.function.name} 没有暴露到 MCP`).toBeDefined();
    }
  });

  it("inputSchema 与内部定义是同一个对象,不是抄的一份", () => {
    for (const t of GIT_TOOLS) {
      const m = MCP_GIT_TOOLS.find((x) => x.name === `zhiyi_${t.function.name}`);
      // 同一个引用 —— 抄一份的话这里会是两个内容相同但不同一的对象,
      // 而内容相同只在"今天"成立
      expect(m?.inputSchema).toBe(t.function.parameters);
    }
  });

  it("MCP 侧不出现手写的 Git 工具定义", () => {
    const src = read("src/lib/mcp/tools.ts");
    expect(src, "又手写了一份 Git 工具的 JSON Schema").not.toMatch(
      /name:\s*"zhiyi_git_/,
    );
  });
});

describe("名字加前缀,避免与别家的工具撞名", () => {
  /**
   * MCP 客户端会同时接好几个服务器。一个叫 git_read_file 的工具
   * 跟别家撞名是迟早的事,而撞名之后调用会落到哪一边是不确定的。
   */
  it("全部以 zhiyi_ 开头", () => {
    for (const t of [...MCP_TOOLS, ...MCP_GIT_TOOLS]) {
      expect(t.name.startsWith("zhiyi_"), `${t.name} 没有前缀`).toBe(true);
    }
  });

  it("工作区工具与 Git 工具没有重名", () => {
    const names = [...MCP_TOOLS, ...MCP_GIT_TOOLS].map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("硬规则在 MCP 这条路上同样生效", () => {
  /**
   * 关键点:MCP 不另写执行逻辑,而是装配上下文后交给**同一个** executeGitTool。
   *
   * 两份实现的话,模型完全可能在某一条路上绕过另一条路上的硬规则 ——
   * 比如从 MCP 进来就能直接写 main。这不是假想:白名单校验和
   * 「不许直接写默认分支」都只写在 executeGitTool 里。
   */
  it("MCP 走的是内部同一个执行器", () => {
    const src = read("src/lib/mcp/tools.ts");
    expect(src).toContain("executeGitTool");
    expect(src, "MCP 侧自己调了 GitHub 接口 —— 那就绕过了硬规则").not.toMatch(
      /commitFiles|openPullRequest|readRepoFile\(/,
    );
  });

  it("上下文装配也是同一份", () => {
    const src = read("src/lib/mcp/tools.ts");
    expect(src).toContain("loadGitContext");
  });

  it("「不许直接写默认分支」仍然只写在执行器里", () => {
    const git = read("src/lib/ai/git-tools.ts");
    expect(git).toMatch(/不能直接提交到默认分支/);
  });
});

describe("没连仓库时的表现", () => {
  it("工具清单里不出现 Git 工具", () => {
    // 列一个必然失败的工具,对面会先花几轮去试,而真正的原因
    // (这个组织还没连 GitHub)它无从得知。不如不列。
    const src = read("src/lib/mcp/tools.ts");
    expect(src).toMatch(/export async function listMcpTools/);
    expect(src).toMatch(/git_installations/);
  });

  it("协议层按「认得出就放行」判,不按「当前能不能用」判", () => {
    // 当成 JSON-RPC 的「未知工具」拒掉的话,对面看到的是协议层错误,
    // 只会以为是版本不匹配 —— 把一个可解决的问题伪装成不可解决的。
    const proto = read("src/lib/mcp/protocol.ts");
    expect(proto).toContain("MCP_GIT_TOOLS.some");
  });

  it("真调用时给的是能照做的说明,不是一句「失败」", () => {
    const src = read("src/lib/mcp/tools.ts");
    expect(src).toMatch(/设置 → 集成/);
  });
});
