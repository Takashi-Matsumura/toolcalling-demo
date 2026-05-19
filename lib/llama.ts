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

export const SYSTEM_PROMPT = `あなたは Web を調べて答えるアシスタントです。

利用できるツールは4つです:
  web_search(query: string) — Web を検索し、上位の検索結果(タイトル/URL/概要)を返す
  fetch_page(url: string)   — 指定 URL のページ本文を取得し、抽出テキストを返す
  arxiv(query: string)      — 学術論文を検索し、論文の題名/著者/年/概要/URL を返す
  github(query: string)     — OSS リポジトリを検索し、名前/説明/スター数/言語/URL を返す

【ツールの使い分け】
- 研究・理論・論文・最新手法を問われたら arxiv。
- 実装・ライブラリ・コード例・OSS を問われたら github。
- 一般的な事実・最新情報は web_search。
- いずれも一覧の URL だけでは中身が分からない。論文の主旨や実装の
  詳細が必要なら、その URL を fetch_page で精読する。

【調査の手順】
1. 質問に応じて web_search / arxiv / github のいずれかで候補を見つける。
2. 概要だけで具体的に答えられないなら、最も適切な URL を fetch_page で読む。
3. 取得した内容を根拠に、ユーザーの質問へ具体的に答える。

重要: 「詳しくはこちらを参照」で終わらせない。ツールで得た内容から、
ユーザーが欲しい答えを自分の言葉で明示すること。
答えが無ければ別の URL を fetch_page するか、別ツールで再検索する。

【ツールの呼び出し方】
ツールを使うときは、返答として **次のいずれかの JSON だけ** を、
前後に一切の説明文を付けずに出力してください:
{"tool": "web_search", "query": "検索クエリ"}
{"tool": "fetch_page", "url": "https://..."}
{"tool": "arxiv", "query": "検索クエリ"}
{"tool": "github", "query": "検索クエリ"}

【最終回答の仕方】
ツールが不要、または取得済み情報で答えられる場合は、
JSON を出さず、通常の文章で日本語で回答してください。
根拠にした情報の URL を文末に併記してください。

重要: ツールを呼ぶターンでは JSON 以外を絶対に出力しないこと。`;

export type ToolCall =
  | { tool: "web_search"; query: string }
  | { tool: "fetch_page"; url: string }
  | { tool: "arxiv"; query: string }
  | { tool: "github"; query: string };

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
          if (
            obj &&
            obj.tool === "fetch_page" &&
            typeof obj.url === "string" &&
            /^https?:\/\//.test(obj.url.trim())
          ) {
            return { tool: "fetch_page", url: obj.url.trim() };
          }
          if (
            obj &&
            (obj.tool === "arxiv" || obj.tool === "github") &&
            typeof obj.query === "string" &&
            obj.query.trim()
          ) {
            return { tool: obj.tool, query: obj.query.trim() };
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
