import { defineConfig } from "vitest/config";

/**
 * 真实网络冒烟专用配置。
 *
 * 与 vitest.config.ts 的区别:include 只收 tests/live/,且**不**排除它。
 * 主配置的 exclude: ["tests/live/**"] 会让显式指定 tests/live 也找不到文件
 * (exclude 优先于 include 与 CLI 参数),所以冒烟测试必须走独立配置。
 *
 * 用途:`pnpm test:live`(package.json)与 ci.yml 的「真实网络冒烟」job。
 * 详见 tests/live/live-slug-check.test.ts 头部注释:为什么与主门禁隔离。
 */
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/live/**/*.test.ts", "tests/live/**/*.test.tsx"],
    maxWorkers: 2,
  },
});
