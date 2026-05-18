// llama-server (OpenAI 互換 /v1/chat/completions) の薄いクライアントと、
// プロンプトベース Tool calling のための仕様プロンプト・パーサ。
//
// なぜプロンプトベースか:
//   gemma-4-e4b-it のチャットテンプレートには tool 定義が無く、
//   OpenAI の tools パラメータを渡しても構造化 tool_calls が安定して返らない。
//   そこで「ツールを使いたい時は決まった JSON だけ出力せよ」と指示し、
//   アプリ側でその JSON を検出・実行する。これが Tool calling の本質そのもの。

const LLAMA_BASE_URL =
  process.env.LLAMA_BASE_URL ?? "http://localhost:8080/v1";
const LLAMA_MODEL =
  process.env.LLAMA_MODEL ?? "gemma-4-e4b-it-Q4_K_M.gguf";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export const SYSTEM_PROMPT = `あなたは Web 検索ツールを使えるアシスタントです。

利用できるツールは1つだけです:
  web_search(query: string) — Web を検索し、上位の検索結果(タイトル/URL/概要)を返す

【ツールの呼び出し方】
最新情報・事実確認・あなたが知らない事柄が必要なときは、
返答として **次の JSON だけ** を、前後に一切の説明文を付けずに出力してください:
{"tool": "web_search", "query": "検索クエリ"}

【最終回答の仕方】
検索が不要、または検索結果を踏まえて回答できる場合は、
JSON を出さず、通常の文章で日本語で回答してください。
検索結果を使った場合は、参照した情報の URL を文末に併記してください。

重要: ツールを呼ぶターンでは JSON 以外を絶対に出力しないこと。`;

type ToolCall = { tool: "web_search"; query: string };

// LLM 出力からツール呼び出し JSON を抽出する。
// ```json フェンスや前後の余計なテキストが付くケースにも耐える。
export function parseToolCall(text: string): ToolCall | null {
  const stripped = text
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();

  // 最初の { から対応する } までを素朴に走査
  const start = stripped.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < stripped.length; i++) {
    if (stripped[i] === "{") depth++;
    else if (stripped[i] === "}") {
      depth--;
      if (depth === 0) {
        const candidate = stripped.slice(start, i + 1);
        try {
          const obj = JSON.parse(candidate);
          if (
            obj &&
            obj.tool === "web_search" &&
            typeof obj.query === "string" &&
            obj.query.trim()
          ) {
            return { tool: "web_search", query: obj.query.trim() };
          }
        } catch {
          // JSON でなければツール呼び出しではない = 通常回答
        }
        return null;
      }
    }
  }
  return null;
}

export async function chatCompletion(
  messages: ChatMessage[],
): Promise<string> {
  const res = await fetch(`${LLAMA_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: LLAMA_MODEL,
      messages,
      temperature: 0.3,
      stream: false,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `llama-server 呼び出し失敗 (HTTP ${res.status}). ` +
        `${LLAMA_BASE_URL} で起動しているか確認してください。${body.slice(0, 200)}`,
    );
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return data.choices?.[0]?.message?.content ?? "";
}
