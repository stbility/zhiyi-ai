/**
 * /api/agent SSE 流 → 最终输出文本。
 *
 * 工作流步骤执行与评测 runner 共用同一读取逻辑:
 * 事件 delta 累积为输出,error 事件抛错,done 结束。
 */

export async function readAgentStream(res: Response): Promise<string> {
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    return (await res.text()).slice(0, 2000);
  }
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  let output = "";
  let streamError: string | null = null;

  const handleData = (data: string) => {
    if (eventName === "delta") {
      try {
        const parsed = JSON.parse(data) as unknown;
        if (typeof parsed === "string") output += parsed;
        else if (
          typeof parsed === "object" &&
          parsed !== null &&
          typeof (parsed as { text?: unknown }).text === "string"
        ) {
          output += (parsed as { text: string }).text;
        }
      } catch {
        output += data;
      }
    } else if (eventName === "error") {
      try {
        const parsed = JSON.parse(data) as { message?: unknown };
        streamError = typeof parsed.message === "string" ? parsed.message : "步骤执行失败";
      } catch {
        streamError = "步骤执行失败";
      }
    }
    eventName = "";
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) handleData(line.slice(5).trim());
      }
    }
  }
  if (streamError) throw new Error(streamError);
  return output.trim();
}
