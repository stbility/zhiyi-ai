/**
 * 知识库文件解析。
 *
 * 支持 pdf / docx / md / txt;不支持的扩展名如实报「不支持的类型」,
 * 绝不返回空文本假装解析成功。解析在服务端同步执行(v1),
 * 后台队列上线后此模块保持不变,只换调用方。
 */

export type KnowledgeFileType = "pdf" | "docx" | "md" | "txt" | "other";

/** 解析后入库的正文上限(超出截断,防止单文件撑爆上下文) */
export const KNOWLEDGE_TEXT_MAX_CHARS = 100_000;

/** 上传原始字节上限 */
export const KNOWLEDGE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

export function detectFileType(name: string): KnowledgeFileType {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "pdf":
      return "pdf";
    case "docx":
      return "docx";
    case "md":
    case "markdown":
      return "md";
    case "txt":
      return "txt";
    default:
      return "other";
  }
}

/** 纯函数:正文截断(可单测) */
export function truncateKnowledgeText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= KNOWLEDGE_TEXT_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, KNOWLEDGE_TEXT_MAX_CHARS)}…(截断)`;
}

/**
 * pdfjs-dist 5.x 的 Node 兼容 polyfill(2026-08-12 修复)。
 *
 * 背景:pdf-parse 2.4.5 依赖 pdfjs-dist 5.4.296,它在解析含字体/图形的
 * PDF 时会调用浏览器全局 DOMMatrix —— Vercel/Node 服务端没有这个 API,
 * 用户实测报「DOMMatrix is not defined」(最小 PDF 能过是因为没触发
 * 字体矩阵路径,真实 PDF 必炸)。
 *
 * pdfjs 官方文档明确:Node 环境使用需自行注入 DOMMatrix polyfill。
 * 这里实现 pdfjs 实际用到的 2D 矩阵子集(构造 + 变换),解析后不残留。
 */
function installPdfjsPolyfills(): void {
  if (typeof globalThis.DOMMatrix === "function") return;

  class DOMMatrixPolyfill {
    a: number; b: number; c: number; d: number; e: number; f: number;

    constructor(init?: string | number[] | Record<string, number> | null) {
      this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
      if (typeof init === "string") {
        const m = init.match(/matrix\(([^)]+)\)/);
        if (m) {
          const v = m[1]!.split(",").map((s) => parseFloat(s.trim()));
          if (v.length >= 6) {
            [this.a, this.b, this.c, this.d, this.e, this.f] = v as [
              number, number, number, number, number, number,
            ];
          }
        }
      } else if (Array.isArray(init) && init.length >= 6) {
        [this.a, this.b, this.c, this.d, this.e, this.f] = init as [
          number, number, number, number, number, number,
        ];
      } else if (init && typeof init === "object" && !Array.isArray(init)) {
        this.a = init.a ?? 1; this.b = init.b ?? 0; this.c = init.c ?? 0;
        this.d = init.d ?? 1; this.e = init.e ?? 0; this.f = init.f ?? 0;
      }
    }

    multiply(other: DOMMatrixPolyfill): DOMMatrixPolyfill {
      return new DOMMatrixPolyfill([
        this.a * other.a + this.c * other.b,
        this.b * other.a + this.d * other.b,
        this.a * other.c + this.c * other.d,
        this.b * other.c + this.d * other.d,
        this.a * other.e + this.c * other.f + this.e,
        this.b * other.e + this.d * other.f + this.f,
      ]);
    }

    translate(tx: number, ty: number): DOMMatrixPolyfill {
      return new DOMMatrixPolyfill([
        this.a, this.b, this.c, this.d,
        this.a * tx + this.c * ty + this.e,
        this.b * tx + this.d * ty + this.f,
      ]);
    }

    scale(sx: number, sy = sx): DOMMatrixPolyfill {
      return new DOMMatrixPolyfill([
        this.a * sx, this.b * sx, this.c * sy, this.d * sy, this.e, this.f,
      ]);
    }

    rotate(angle: number): DOMMatrixPolyfill {
      const rad = (angle * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      return new DOMMatrixPolyfill([
        this.a * cos + this.c * sin,
        this.b * cos + this.d * sin,
        this.a * -sin + this.c * cos,
        this.b * -sin + this.d * cos,
        this.e,
        this.f,
      ]);
    }

    inverse(): DOMMatrixPolyfill {
      const det = this.a * this.d - this.b * this.c;
      if (Math.abs(det) < 1e-12) return new DOMMatrixPolyfill();
      const invDet = 1 / det;
      return new DOMMatrixPolyfill([
        this.d * invDet,
        -this.b * invDet,
        -this.c * invDet,
        this.a * invDet,
        (this.c * this.f - this.d * this.e) * invDet,
        (this.b * this.e - this.a * this.f) * invDet,
      ]);
    }

    transformPoint(p: { x: number; y: number }): { x: number; y: number } {
      return {
        x: this.a * p.x + this.c * p.y + this.e,
        y: this.b * p.x + this.d * p.y + this.f,
      };
    }
  }

  (globalThis as Record<string, unknown>).DOMMatrix = DOMMatrixPolyfill;
  (globalThis as Record<string, unknown>).DOMPoint = class {
    x: number; y: number;
    constructor(x = 0, y = 0) { this.x = x; this.y = y; }
  };
}

export async function extractText(
  buffer: Uint8Array,
  fileType: KnowledgeFileType,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    if (fileType === "txt" || fileType === "md") {
      // 文本格式:UTF-8 解码;乱码风险低,失败也不伪装
      const text = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
      return { ok: true, text: truncateKnowledgeText(text) };
    }

    if (fileType === "docx") {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer: Buffer.from(buffer) });
      const text = (result.value ?? "").replace(/\r\n/g, "\n");
      return { ok: true, text: truncateKnowledgeText(text) };
    }

    if (fileType === "pdf") {
      // pdf-parse v2:PDFParse 类,getText() 返回文本
      // 先装 pdfjs 的 Node polyfill(DOMMatrix/DOMPoint),否则含字体/图形的
      // 真实 PDF 报「DOMMatrix is not defined」
      installPdfjsPolyfills();
      const { PDFParse } = await import("pdf-parse");
      const pdf = new PDFParse({ data: Buffer.from(buffer) });
      const result = await pdf.getText();
      const text =
        typeof result === "string" ? result : ((result as { text?: unknown }).text as string) ?? "";
      if (text.trim() === "") {
        return { ok: false, error: "PDF 未提取到文本(可能是扫描件,暂不支持 OCR)。" };
      }
      return { ok: true, text: truncateKnowledgeText(text.replace(/\r\n/g, "\n")) };
    }

    return { ok: false, error: `暂不支持 ${fileType} 类型文件。` };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "解析失败(未知错误)。",
    };
  }
}
