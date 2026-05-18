import {
  chatCompletion,
  parseToolCall,
  SYSTEM_PROMPT,
  type ChatMessage,
} from "@/lib/llama";
import { formatResultsForModel, webSearch } from "@/lib/web-search";

// Tool calling のループ本体を SSE でストリーミングする。
// 各段の開始(phase)と結果(step)をリアルタイムに送出し、
// クライアント側のワークフロー図がライブで進行できるようにする。

export const dynamic = "force-dynamic";

const MAX_STEPS = 4; // 無限ループ防止

type Step =
  | { type: "llm_raw"; content: string }
  | { type: "tool_call"; query: string }
  | {
      type: "tool_result";
      query: string;
      results: { title: string; url: string; snippet: string }[];
    }
  | { type: "final"; text: string }
  | { type: "error"; message: string };

// ワークフローのフェーズ。クライアントの図のノードに対応する。
type Phase = "llm" | "tool_call" | "search" | "feedback" | "final";

type StreamEvent =
  | { kind: "phase"; phase: Phase; iter: number }
  | { kind: "step"; step: Step }
  | { kind: "answer"; answer: string }
  | { kind: "done" };

export async function POST(request: Request) {
  const { messages } = (await request.json()) as {
    messages: { role: "user" | "assistant"; content: string }[];
  };

  const convo: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...messages,
  ];

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: StreamEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      };

      try {
        for (let i = 0; i < MAX_STEPS; i++) {
          const iter = i + 1;

          send({ kind: "phase", phase: "llm", iter });
          const raw = await chatCompletion(convo);
          send({ kind: "step", step: { type: "llm_raw", content: raw } });

          const toolCall = parseToolCall(raw);

          if (!toolCall) {
            // ツール要求なし = これが最終回答
            send({ kind: "phase", phase: "final", iter });
            send({ kind: "step", step: { type: "final", text: raw } });
            send({ kind: "answer", answer: raw });
            send({ kind: "done" });
            controller.close();
            return;
          }

          // モデルがツールを要求した
          send({ kind: "phase", phase: "tool_call", iter });
          send({
            kind: "step",
            step: { type: "tool_call", query: toolCall.query },
          });

          // SearXNG 検索実行
          send({ kind: "phase", phase: "search", iter });
          const results = await webSearch(toolCall.query);
          send({
            kind: "step",
            step: {
              type: "tool_result",
              query: toolCall.query,
              results,
            },
          });

          // 結果を会話に戻して次ターンへ
          send({ kind: "phase", phase: "feedback", iter });
          convo.push({ role: "assistant", content: raw });
          convo.push({
            role: "user",
            content:
              `web_search("${toolCall.query}") の結果:\n\n` +
              formatResultsForModel(results) +
              `\n\nこの結果を踏まえてユーザーに日本語で最終回答してください。` +
              `さらに検索が必要なら再度ツール JSON を出力しても構いません。`,
          });
        }

        // MAX_STEPS 到達: 最後にもう一度、検索結果を踏まえた回答を強制
        send({ kind: "phase", phase: "final", iter: MAX_STEPS });
        const finalRaw = await chatCompletion(convo);
        send({ kind: "step", step: { type: "final", text: finalRaw } });
        send({ kind: "answer", answer: finalRaw });
        send({ kind: "done" });
        controller.close();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        send({ kind: "step", step: { type: "error", message } });
        send({ kind: "answer", answer: "" });
        send({ kind: "done" });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
