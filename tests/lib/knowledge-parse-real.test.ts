import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { extractText, truncateKnowledgeText } from "@/lib/knowledge/parse";

/**
 * 知识库真实解析契约(2026-08-12 补)。
 *
 * 背景:此前测试只覆盖 detectFileType/truncate,extractText 的
 * pdf/docx 真实解析从未被验证 —— 用户报「解析报错不工作」时
 * CI 全绿,因为根本没测解析本身。本测试用最小合法文件实测。
 */

/** 最小合法 PDF:含一行文本 "Hello Zhiyi" */
const MINIMAL_PDF = Buffer.from(
  `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R>>endobj
4 0 obj<</Length 44>>stream
BT /F1 18 Tf 72 720 Td (Hello Zhiyi) Tj ET
endstream
endobj
xref
0 5
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000218 00000 n 
trailer<</Size 5/Root 1 0 R>>
startxref
373
%%EOF`,
  "latin1",
);

describe("知识库真实解析", () => {
  it("txt 解析:UTF-8 解码 + 去首尾空白", async () => {
    const r = await extractText(new Uint8Array(Buffer.from("  会议纪要  ")), "txt");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("会议纪要");
  });

  it("md 解析:原样返回", async () => {
    const r = await extractText(new Uint8Array(Buffer.from("# 标题\n正文")), "md");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain("正文");
  });

  it("pdf 解析:最小 PDF 提取到文本(非空)", async () => {
    const r = await extractText(new Uint8Array(MINIMAL_PDF), "pdf");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toContain("Hello Zhiyi");
      expect(r.text.length).toBeGreaterThan(0);
    }
  });

  it("截断:超长正文标注", () => {
    const long = "x".repeat(100_100);
    const r = truncateKnowledgeText(long);
    expect(r.endsWith("…(截断)")).toBe(true);
  });

  it("pdf 解析前注入 DOMMatrix polyfill(修复 DOMMatrix is not defined)", async () => {
    const src = readFileSync(
      resolve(__dirname, "../../src/lib/knowledge/parse.ts"),
      "utf8",
    );
    // polyfill 定义存在
    expect(src).toMatch(/function installPdfjsPolyfills/);
    expect(src).toMatch(/DOMMatrix/);
    // pdf 分支内调用 installPdfjsPolyfills()(定义在文件前部,调用在分支内)
    const installDefIdx = src.indexOf("function installPdfjsPolyfills");
    const pdfIdx = src.indexOf('if (fileType === "pdf")');
    const callIdx = src.indexOf("installPdfjsPolyfills();");
    expect(installDefIdx).toBeGreaterThan(-1);
    expect(pdfIdx).toBeGreaterThan(-1);
    // 调用点必须在 pdf 分支内(pdfIdx 之后)
    expect(callIdx).toBeGreaterThan(pdfIdx);
  });

  it("带字体资源的 PDF 也能解析(触发字体矩阵路径)", async () => {
    const fontPdf = Buffer.from(
      `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>endobj
4 0 obj<</Length 60>>stream
BT /F1 18 Tf 72 720 Td (Polyfill Works) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000268 00000 n 
0000000348 00000 n 
trailer<</Size 6/Root 1 0 R>>
startxref
402
%%EOF`,
      "latin1",
    );
    const r = await extractText(new Uint8Array(fontPdf), "pdf");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain("Polyfill Works");
  });
});
