/**
 * 把一次「逻辑上的模型回复」造成 OpenAI 兼容的 SSE 响应。
 *
 * 智能体的每一轮改成流式之后(参考 Claude:循环的每一轮都是一次独立的
 * 流式请求),测试夹具也必须是流式的 —— 否则测的是一个产品里不存在的协议。
 *
 * 工具调用刻意**分片**发出:arguments 拆成两段,按 index 累积。
 * 这正是真实上游的行为,也是最容易写错的地方(半截 JSON 不能拿去执行),
 * 所以夹具必须复现它,不能一次给完整的。
 */
export function sseResponse(turn: {
  content?: string;
  reasoning?: string;
  toolCalls?: readonly { id?: string; name: string; args: unknown }[];
  finishReason?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}): Response {
  const frames: string[] = [];
  const push = (obj: unknown) => frames.push(`data: ${JSON.stringify(obj)}\n\n`);

  if (turn.reasoning) {
    push({ choices: [{ delta: { reasoning_content: turn.reasoning } }] });
  }
  if (turn.content) {
    push({ choices: [{ delta: { content: turn.content } }] });
  }

  (turn.toolCalls ?? []).forEach((c, index) => {
    const args = JSON.stringify(c.args);
    const half = Math.ceil(args.length / 2);
    // 第一片带 id 与函数名,参数只给前半段
    push({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index,
                id: c.id ?? `call_${index}`,
                function: { name: c.name, arguments: args.slice(0, half) },
              },
            ],
          },
        },
      ],
    });
    // 第二片只补参数的后半段 —— 累积不对就会解析失败
    push({
      choices: [
        {
          delta: {
            tool_calls: [{ index, function: { arguments: args.slice(half) } }],
          },
        },
      ],
    });
  });

  push({
    choices: [
      {
        delta: {},
        finish_reason:
          turn.finishReason ??
          ((turn.toolCalls?.length ?? 0) > 0 ? "tool_calls" : "stop"),
      },
    ],
  });
  if (turn.usage) push({ choices: [], usage: turn.usage });
  frames.push("data: [DONE]\n\n");

  return new Response(frames.join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}
