import { chatCompletion, type ChatMessage } from "@/lib/llama";

// 回答だけを作り直すエンドポイント。
// ツールループは一切回さない。チャット送信時にクライアントが保存した
// 「そのターンの文脈(ツール結果入り convo)」を受け取り、
// 別表現でもう一度だけ最終回答を生成する。

export const dynamic = "force-dynamic";

const REGEN_INSTRUCTION =
  "上記のここまでの情報だけを根拠に、先ほどの回答とは" +
  "別の表現・別の構成で、より分かりやすく日本語で回答を作り直してください。" +
  "新たなツール呼び出しはせず、JSON は一切出力しないこと。" +
  "根拠にした情報の URL があれば文末に併記してください。";

export async function POST(request: Request) {
  const { context } = (await request.json()) as { context: ChatMessage[] };

  if (!Array.isArray(context) || context.length === 0) {
    return Response.json({ error: "context がありません" }, { status: 400 });
  }

  const messages: ChatMessage[] = [
    ...context,
    { role: "user", content: REGEN_INSTRUCTION },
  ];

  try {
    // 別表現を引き出すため温度を高めにする
    const answer = await chatCompletion(messages, 0.85);
    return Response.json({ answer });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return Response.json({ error: message }, { status: 500 });
  }
}
