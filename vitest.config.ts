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
    // 8GB 机器限制并发，避免内存被打爆
    maxWorkers: 2,
  },
});
