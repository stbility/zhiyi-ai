import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Vite 原生解析 tsconfig 的 paths(@/* → src/*),无需 vite-tsconfig-paths 插件
    tsconfigPaths: true,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // tests/live/ 是真实网络冒烟(打真实 GitHub),从主门禁排除 ——
    // 主门禁必须确定性;它们由 `pnpm test:live` 单独跑,见 ci.yml 的
    // 「真实网络冒烟」job。详见 tests/live/live-slug-check.test.ts 头部注释。
    exclude: ["tests/live/**"],
    // 8GB 机器限制并发，避免内存被打爆
    maxWorkers: 2,
  },
});
