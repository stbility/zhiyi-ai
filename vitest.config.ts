import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // server-only 在 jsdom 环境里没有 Next.js runtime,会抛"不能从 Client Component 导入"。
    // 用 server.deps.inline 全局 mock,让所有测试文件都能正常加载含 `import "server-only"` 的模块。
    server: {
      deps: {
        inline: [/^server-only/],
      },
    },
    // tests/live/ 是真实网络冒烟(打真实 GitHub),从主门禁排除。
    // 主门禁必须确定性;它们由 `pnpm test:live` 单独跑,见 ci.yml 的
    // 「真实网络冒烟」job。
    exclude: ["tests/live/**"],
    maxWorkers: 2,
  },
});
