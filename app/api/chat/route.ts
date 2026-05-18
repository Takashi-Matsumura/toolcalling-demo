import {
  chatCompletion,
  parseToolCall,
  SYSTEM_PROMPT,
  type ChatMessage,
} from "@/lib/llama";
import { formatResultsForModel, webSearch } from "@/lib/web-search";

// Tool calling のループ本体。
// LLM 呼び出し → ツール要求の検出 → ツール実行 → 結果を会話に戻す → 再度 LLM、
// を最終回答が出るまで繰り返す。各段を step として記録し UI に返す
// (= Tool calling の内部動作を可視化する)。

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

export async function POST(request: Request) {
  const { messages } = (await request.json()) as {
    messages: { role: "user" | "assistant"; content: string }[];
  };

  const convo: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...messages,
  ];

  const steps: Step[] = [];

  try {
    for (let i = 0; i < MAX_STEPS; i++) {
      const raw = await chatCompletion(convo);
      steps.push({ type: "llm_raw", content: raw });

      const toolCall = parseToolCall(raw);

      if (!toolCall) {
        // ツール要求なし = これが最終回答
        steps.push({ type: "final", text: raw });
        return Response.json({ steps, answer: raw });
      }

      // モデルがツールを要求した
      steps.push({ type: "tool_call", query: toolCall.query });

      const results = await webSearch(toolCall.query);
      steps.push({
        type: "tool_result",
        query: toolCall.query,
        results,
      });

      // ツールの生出力(モデルの JSON 要求)と実行結果を会話に積み増し、
      // 次ターンでモデルに結果を踏まえさせる
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
    const finalRaw = await chatCompletion(convo);
    steps.push({ type: "final", text: finalRaw });
    return Response.json({ steps, answer: finalRaw });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    steps.push({ type: "error", message });
    return Response.json({ steps, answer: "", error: message }, { status: 500 });
  }
}
