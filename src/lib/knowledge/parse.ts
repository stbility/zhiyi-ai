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
