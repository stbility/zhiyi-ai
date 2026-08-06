/**
 * zhiyi-ai E2E 探索式 QA (单浏览器顺序版)
 * 目标: https://zhiyi-ai.vercel.app
 * 用法: npx tsx tests/e2e/explore-qa.ts
 */

import { chromium, type Page, type ConsoleMessage } from "playwright";

const BASE = "https://zhiyi-ai.vercel.app";
const TIMEOUT = 15_000;

type TestFn = (p: Page) => Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];

function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}

function assert(cond: unknown, hint = "assertion failed") {
  if (!cond) throw new Error(hint);
}

async function expectVisible(p: Page, selector: string, label: string) {
  const el = p.locator(selector).first();
  const ok = await el.isVisible({ timeout: TIMEOUT });
  assert(ok, `${label} (${selector}) 未找到或不可见`);
}

// ─── SUITE 1: 营销页 ─────────────────────────────────────────────────────

test("[/] 加载无控制台错误", async (p) => {
  const errors: ConsoleMessage[] = [];
  p.on("console", (m) => { if (m.type() === "error") errors.push(m); });
  await p.goto(BASE, { waitUntil: "networkidle", timeout: TIMEOUT });
  assert(errors.length === 0, `控制台错误: ${errors.map((e) => e.text()).join("; ")}`);
});

test("[/] 标题含品牌名", async (p) => {
  await p.goto(BASE, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
  const t = await p.title();
  assert(/智一|AI/.test(t), `title="${t}"`);
});

test("[/] 三大价值主张可见", async (p) => {
  await p.goto(BASE, { waitUntil: "networkidle", timeout: TIMEOUT });
  const body = await p.textContent("body");
  for (const t of ["工作流优先", "上下文优先", "行动优先"])
    assert(body?.includes(t), `缺少"${t}"`);
});

test("[/] 「任务到记忆」五步至少出现三步", async (p) => {
  await p.goto(BASE, { waitUntil: "networkidle", timeout: TIMEOUT });
  const body = await p.textContent("body");
  const found = ["输入资料", "AI Agent", "分工执行", "生成结果", "用户确认", "沉淀"]
    .filter((s) => body?.includes(s));
  assert(found.length >= 3, `只找到 ${found.join(",")} (需要≥3)`);
});

test("[/] 记忆卡片示例可见(置信度/来源标注)", async (p) => {
  await p.goto(BASE, { waitUntil: "networkidle", timeout: TIMEOUT });
  const body = await p.textContent("body");
  assert(
    body?.includes("置信度") || body?.includes("AI 自动推断"),
    "记忆卡片 UI 未找到"
  );
});

test("[/] 三档定价可见", async (p) => {
  await p.goto(BASE, { waitUntil: "networkidle", timeout: TIMEOUT });
  const body = await p.textContent("body");
  for (const t of ["Free", "Professional", "Enterprise"])
    assert(body?.includes(t), `缺少"${t}"`);
});

test("[/] Pro/Enterprise 购买按钮禁用(诚实)", async (p) => {
  await p.goto(BASE, { waitUntil: "networkidle", timeout: TIMEOUT });
  const body = await p.textContent("body");
  assert(
    body?.includes("暂不可购买") || body?.includes("价格待定"),
    "未如实展示购买禁用状态"
  );
});

test("[/] Footer 有状态页链接", async (p) => {
  await p.goto(BASE, { waitUntil: "networkidle", timeout: TIMEOUT });
  const link = p.locator('a[href="/status"]').first();
  assert(await link.isVisible({ timeout: 5000 }), 'a[href="/status"] 不可见');
});

// ─── SUITE 2: 状态页 ─────────────────────────────────────────────────────

test("[/status] 加载无控制台错误", async (p) => {
  const errors: ConsoleMessage[] = [];
  p.on("console", (m) => { if (m.type() === "error") errors.push(m); });
  await p.goto(`${BASE}/status`, { waitUntil: "networkidle", timeout: TIMEOUT });
  assert(errors.length === 0, `控制台错误: ${errors.map((e) => e.text()).join("; ")}`);
});

test("[/status] Phase 4 进度可见", async (p) => {
  await p.goto(`${BASE}/status`, { waitUntil: "networkidle", timeout: TIMEOUT });
  const body = await p.textContent("body");
  assert(/Phase 4|进行中/.test(body ?? ""), "Phase 4 进度未找到");
});

test("[/status] 3/5 配置状态如实展示", async (p) => {
  await p.goto(`${BASE}/status`, { waitUntil: "networkidle", timeout: TIMEOUT });
  const body = await p.textContent("body");
  assert(/3.*5|已配置/.test(body ?? ""), "3/5 状态未展示");
});

test("[/status] Stripe 配置不完整如实", async (p) => {
  await p.goto(`${BASE}/status`, { waitUntil: "networkidle", timeout: TIMEOUT });
  const body = await p.textContent("body");
  assert(/stripe|未配置|不完整/i.test(body ?? ""), "Stripe 状态未如实展示");
});

test("[/status] Resend 未配置如实", async (p) => {
  await p.goto(`${BASE}/status`, { waitUntil: "networkidle", timeout: TIMEOUT });
  const body = await p.textContent("body");
  assert(/resend|未配置/i.test(body ?? ""), "Resend 状态未如实展示");
});

test("[/status] 有填写指南", async (p) => {
  await p.goto(`${BASE}/status`, { waitUntil: "networkidle", timeout: TIMEOUT });
  const body = await p.textContent("body");
  assert(/\.env|环境变量|填写/i.test(body ?? ""), "无填写指南");
});

// ─── SUITE 3: 登录页 ─────────────────────────────────────────────────────

test("[/login] 加载无控制台错误", async (p) => {
  const errors: ConsoleMessage[] = [];
  p.on("console", (m) => { if (m.type() === "error") errors.push(m); });
  await p.goto(`${BASE}/login`, { waitUntil: "networkidle", timeout: TIMEOUT });
  assert(errors.length === 0, `控制台错误: ${errors.map((e) => e.text()).join("; ")}`);
});

test("[/login] 邮箱/密码输入框可见", async (p) => {
  await p.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
  await expectVisible(p, 'input[type="email"]', "邮箱输入框");
  await expectVisible(p, 'input[type="password"]', "密码输入框");
});

test("[/login] 登录按钮可见", async (p) => {
  await p.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
  const btn = p.locator('button[type="submit"]').first();
  assert(await btn.isVisible({ timeout: 5000 }), "提交按钮不可见");
});

test("[/login] 第三方 OAuth 入口可见", async (p) => {
  await p.goto(`${BASE}/login`, { waitUntil: "networkidle", timeout: TIMEOUT });
  const text = await p.textContent("body");
  assert(/google|github|继续|oauth/i.test(text ?? ""), "无 OAuth 入口");
});

test("[/login] 注册跳转链接可见", async (p) => {
  await p.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
  const link = p.locator('a[href="/register"]').first();
  assert(await link.isVisible({ timeout: 5000 }), 'a[href="/register"] 不可见');
});

test("[/login] 无效凭证提交停留登录页", async (p) => {
  await p.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
  await p.fill('input[type="email"]', "bad@test.com");
  await p.fill('input[type="password"]', "x");
  await p.click('button[type="submit"]');
  await p.waitForTimeout(3000);
  assert(p.url().includes("/login"), `跳转到了 ${p.url()}`);
});

// ─── SUITE 4: 注册页 ─────────────────────────────────────────────────────

test("[/register] 加载无控制台错误", async (p) => {
  const errors: ConsoleMessage[] = [];
  p.on("console", (m) => { if (m.type() === "error") errors.push(m); });
  await p.goto(`${BASE}/register`, { waitUntil: "networkidle", timeout: TIMEOUT });
  assert(errors.length === 0, `控制台错误: ${errors.map((e) => e.text()).join("; ")}`);
});

test("[/register] 邮箱/密码输入框可见", async (p) => {
  await p.goto(`${BASE}/register`, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
  await expectVisible(p, 'input[type="email"]', "邮箱输入框");
  await expectVisible(p, 'input[type="password"]', "密码输入框");
});

test("[/register] 注册按钮可见", async (p) => {
  await p.goto(`${BASE}/register`, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
  const btn = p.locator('button[type="submit"]').first();
  assert(await btn.isVisible({ timeout: 5000 }), "提交按钮不可见");
});

test("[/register] 第三方 OAuth 入口可见", async (p) => {
  await p.goto(`${BASE}/register`, { waitUntil: "networkidle", timeout: TIMEOUT });
  const text = await p.textContent("body");
  assert(/google|github|继续|oauth/i.test(text ?? ""), "无 OAuth 入口");
});

test("[/register] 密码过短时停留本页", async (p) => {
  await p.goto(`${BASE}/register`, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
  await p.fill('input[type="email"]', "test@example.com");
  await p.fill('input[type="password"]', "123");
  await p.click('button[type="submit"]');
  await p.waitForTimeout(1500);
  assert(p.url().endsWith("/register"), `跳转到了 ${p.url()}`);
});

test("[/register] 已有账号链接指向 /login", async (p) => {
  await p.goto(`${BASE}/register`, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
  const link = p.locator('a[href="/login"]').first();
  assert(await link.isVisible({ timeout: 5000 }), 'a[href="/login"] 不可见');
});

// ─── SUITE 5: 导航连贯性 ─────────────────────────────────────────────────

test("[导航] 顶部导航可见", async (p) => {
  await p.goto(BASE, { waitUntil: "networkidle", timeout: TIMEOUT });
  const nav = p.locator("nav, header").first();
  assert(await nav.isVisible({ timeout: 5000 }), "顶部导航不可见");
});

test("[导航] /login → /register 点击跳转", async (p) => {
  await p.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
  await p.click('a[href="/register"]');
  await p.waitForURL(/\/register/, { timeout: 8000 });
  assert(p.url().endsWith("/register"), `url=${p.url()}`);
});

test("[导航] /register → /login 点击跳转", async (p) => {
  await p.goto(`${BASE}/register`, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
  await p.click('a[href="/login"]');
  await p.waitForURL(/\/login/, { timeout: 8000 });
  assert(p.url().endsWith("/login"), `url=${p.url()}`);
});

test("[导航] 营销页「免费开始」CTA → 注册页", async (p) => {
  await p.goto(BASE, { waitUntil: "networkidle", timeout: TIMEOUT });
  await p.locator("text=免费开始").first().click();
  await p.waitForURL(/\/register/, { timeout: 8000 });
  assert(p.url().endsWith("/register"), `url=${p.url()}`);
});

test("[导航] Footer 状态页链接可访问", async (p) => {
  await p.goto(BASE, { waitUntil: "networkidle", timeout: TIMEOUT });
  await p.click('a[href="/status"]');
  await p.waitForURL(/\/status/, { timeout: 8000 });
  assert(p.url().endsWith("/status"), `url=${p.url()}`);
});

// ─── SUITE 6: 响应式 ─────────────────────────────────────────────────────

test("[响应式] 移动端(375px)营销页正常加载", async (p) => {
  await p.setViewportSize({ width: 375, height: 812 });
  const errors: ConsoleMessage[] = [];
  p.on("console", (m) => { if (m.type() === "error") errors.push(m); });
  await p.goto(BASE, { waitUntil: "networkidle", timeout: TIMEOUT });
  assert(errors.length === 0, `移动端有 ${errors.length} 个错误`);
  await expectVisible(p, "text=个人 AI 工作流操作系统", "移动端主标题");
});

test("[响应式] 移动端(375px)登录页布局正常", async (p) => {
  await p.setViewportSize({ width: 375, height: 812 });
  await p.goto(`${BASE}/login`, { waitUntil: "networkidle", timeout: TIMEOUT });
  await expectVisible(p, 'input[type="email"]', "移动端邮箱输入");
  await expectVisible(p, 'input[type="password"]', "移动端密码输入");
});

// ─── SUITE 7: 性能 ───────────────────────────────────────────────────────

test("[性能] 营销页 LCP < 3s", async (p) => {
  await p.goto(BASE, { waitUntil: "load", timeout: TIMEOUT });
  const lcp = await p.evaluate(() => {
    const entries = performance.getEntriesByType("largest-contentful-paint") as PerformanceEntry[];
    return (entries.at(-1)?.startTime ?? 0) / 1000;
  });
  assert(lcp < 3, `LCP = ${lcp.toFixed(2)}s (要求 < 3s)`);
  console.log(`        └─ LCP: ${lcp.toFixed(2)}s`);
});

test("[性能] 所有页面 <title> 有效", async (p) => {
  for (const path of ["/", "/status", "/login", "/register"]) {
    await p.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
    const title = await p.title();
    assert(
      title.trim().length > 0 && !title.toLowerCase().startsWith("untitled"),
      `页面${path} title="${title}"无效`
    );
  }
});

// ─── 主入口 ─────────────────────────────────────────────────────────────────

(async () => {
  console.log("═══════════════════════════════════════");
  console.log(" zhiyi-ai E2E 探索式 QA");
  console.log(` 目标: ${BASE}`);
  console.log(` 测试数: ${tests.length}`);
  console.log("═══════════════════════════════════════");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  for (const { name, fn } of tests) {
    try {
      await fn(page);
      console.log(`  ✅ ${name}`);
      passed++;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message.slice(0, 150) : String(e);
      console.log(`  ❌ ${name}`);
      console.log(`     └─ ${msg}`);
      failures.push(`${name}: ${msg}`);
      failed++;
    }
  }

  await browser.close();

  console.log("\n═══════════════════════════════════════");
  console.log(` 结果: ${passed}/${passed + failed} 通过`);
  if (failures.length > 0) {
    console.log(`\n 失败项 (${failures.length}):`);
    failures.forEach((f) => console.log(`  ❌ ${f}`));
  }
  console.log("═══════════════════════════════════════");
  process.exit(failed === 0 ? 0 : 1);
})();
