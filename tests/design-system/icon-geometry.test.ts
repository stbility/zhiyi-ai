import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 图标几何守护。
 *
 * 起因是真实缺陷:download 由 upload 上下翻转而来,箭尖落在 y=19,
 * 与 y=21 的底线不到一个单位。加上 strokeWidth 1.75 的圆头描边,
 * 14px 下两者糊在一起,用户看到的是「箭头下面莫名多了一横」。
 *
 * upload 没这个毛病 —— 挨着底线的是细箭尾,不是宽箭头。
 * 所以这条测试只约束「箭头指向底线」的那一类图标。
 */
const SOURCE = readFileSync(
  resolve(__dirname, "../../src/components/icons/Icon.tsx"),
  "utf8",
);

/** 底线的 y —— 描边中心 */
const BASELINE_Y = 21;
/** strokeWidth 1.75 圆头:描边各向外扩 0.875,两条线各让一半,再留出可辨识的空隙 */
const MIN_GAP = 3;

describe("图标几何", () => {
  it("download 的箭尖与底线留有可辨识的间距", () => {
    const block = /download:\s*\(([\s\S]*?)\n  \),/.exec(SOURCE)?.[1];
    expect(block, "找不到 download 图标定义").toBeTruthy();

    const points = /<polyline points="([^"]+)"/.exec(block!)?.[1];
    expect(points, "download 应当用 polyline 画箭头").toBeTruthy();

    const ys = points!
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter((_, i) => i % 2 === 1);
    const tipY = Math.max(...ys);

    expect(block).toContain(`h14`); // 底线仍在
    expect(BASELINE_Y - tipY).toBeGreaterThanOrEqual(MIN_GAP);
  });

  it("download 的箭头朝下,upload 的箭头朝上", () => {
    const tipOf = (name: string) => {
      const block = new RegExp(`${name}:\\s*\\(([\\s\\S]*?)\\n  \\),`).exec(
        SOURCE,
      )?.[1];
      const points = /<polyline points="([^"]+)"/.exec(block!)![1]!;
      const nums = points.trim().split(/\s+/).map(Number);
      const ys = nums.filter((_, i) => i % 2 === 1);
      // 箭尖是三点中 y 与另外两点不同的那个
      return { first: ys[0]!, mid: ys[1]!, last: ys[2]! };
    };

    const down = tipOf("download");
    expect(down.mid).toBeGreaterThan(down.first); // 中间点更靠下 = 朝下

    const up = tipOf("upload");
    expect(up.mid).toBeLessThan(up.first); // 中间点更靠上 = 朝上
  });
});
