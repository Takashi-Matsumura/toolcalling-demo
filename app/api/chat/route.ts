import {
  chatCompletion,
  parseToolCall,
  SYSTEM_PROMPT,
  type ChatMessage,
} from "@/lib/llama";
import { formatResultsForModel, webSearch } from "@/lib/web-search";
import { fetchPage } from "@/lib/fetch-page";
import { arxivSearch, formatArxivForModel } from "@/lib/arxiv";
import { githubSearch, formatGithubForModel } from "@/lib/github";

// Tool calling のループ本体を SSE でストリーミングする。
// web_search / fetch_page / arxiv / github の4ツールに対応。
// 各段の開始(phase)と結果(step)をリアルタイムに送出する。

export const dynamic = "force-dynamic";

const MAX_STEPS = 6; // 無限ループ防止 (検索→専門検索→精読→回答に余裕)

type ToolName = "web_search" | "fetch_page" | "arxiv" | "github";

type Step =
  | { type: "llm_raw"; content: string }
  | { type: "tool_call"; tool: ToolName; arg: string }
  | {
      type: "search_result";
      query: string;
      results: { title: string; url: string; snippet: string }[];
    }
  | { type: "fetch_result"; url: string; ok: boolean; chars: number }
  | {
      type: "arxiv_result";
      query: string;
      papers: {
        title: string;
        authors: string[];
        year: string;
        summary: string;
        url: string;
        source: "arxiv" | "openalex";
      }[];
    }
  | {
      type: "github_result";
      query: string;
      repos: {
        fullName: string;
        description: string;
        stars: number;
        language: string;
        url: string;
      }[];
    }
  | { type: "final"; text: string }
  | { type: "error"; message: string };

// ワークフローのフェーズ。クライアントの図のノードに対応する。
type Phase = "llm" | "tool_call" | "tool_exec" | "feedback" | "final";

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
      const finish = (answer: string) => {
        send({ kind: "answer", answer });
        send({ kind: "done" });
        controller.close();
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
            finish(raw);
            return;
          }

          send({ kind: "phase", phase: "tool_call", iter });

          if (toolCall.tool === "web_search") {
            send({
              kind: "step",
              step: {
                type: "tool_call",
                tool: "web_search",
                arg: toolCall.query,
              },
            });

            send({ kind: "phase", phase: "tool_exec", iter });
            const results = await webSearch(toolCall.query);
            send({
              kind: "step",
              step: {
                type: "search_result",
                query: toolCall.query,
                results,
              },
            });

            send({ kind: "phase", phase: "feedback", iter });
            convo.push({ role: "assistant", content: raw });
            convo.push({
              role: "user",
              content:
                `web_search("${toolCall.query}") の結果:\n\n` +
                formatResultsForModel(results) +
                `\n\n上は概要のみです。ユーザーが具体的な事実(天気・数値・` +
                `最新状況など)を求めている場合、概要だけで答えず、最も` +
                `適切な URL に fetch_page を使って本文を読んでください。` +
                `概要だけで十分なら日本語で最終回答してください。`,
            });
          } else if (toolCall.tool === "fetch_page") {
            send({
              kind: "step",
              step: {
                type: "tool_call",
                tool: "fetch_page",
                arg: toolCall.url,
              },
            });

            send({ kind: "phase", phase: "tool_exec", iter });
            const page = await fetchPage(toolCall.url);
            send({
              kind: "step",
              step: {
                type: "fetch_result",
                url: page.url,
                ok: page.ok,
                chars: page.chars,
              },
            });

            send({ kind: "phase", phase: "feedback", iter });
            convo.push({ role: "assistant", content: raw });
            convo.push({
              role: "user",
              content:
                `fetch_page("${toolCall.url}") で取得した本文:\n\n` +
                page.text +
                `\n\nこの本文を根拠に、ユーザーの質問へ具体的に日本語で` +
                `答えてください。本文に答えが無ければ別の URL を` +
                `fetch_page するか web_search し直してください。`,
            });
          } else if (toolCall.tool === "arxiv") {
            send({
              kind: "step",
              step: { type: "tool_call", tool: "arxiv", arg: toolCall.query },
            });

            send({ kind: "phase", phase: "tool_exec", iter });
            const papers = await arxivSearch(toolCall.query);
            send({
              kind: "step",
              step: {
                type: "arxiv_result",
                query: toolCall.query,
                papers,
              },
            });

            send({ kind: "phase", phase: "feedback", iter });
            convo.push({ role: "assistant", content: raw });
            convo.push({
              role: "user",
              content:
                `arxiv("${toolCall.query}") の結果:\n\n` +
                formatArxivForModel(papers) +
                `\n\n論文の主旨を詳しく述べる必要があれば、その abs URL を` +
                ` fetch_page で精読してください。要点を踏まえて日本語で` +
                `具体的に回答してください。`,
            });
          } else {
            // github
            send({
              kind: "step",
              step: { type: "tool_call", tool: "github", arg: toolCall.query },
            });

            send({ kind: "phase", phase: "tool_exec", iter });
            const repos = await githubSearch(toolCall.query);
            send({
              kind: "step",
              step: {
                type: "github_result",
                query: toolCall.query,
                repos,
              },
            });

            send({ kind: "phase", phase: "feedback", iter });
            convo.push({ role: "assistant", content: raw });
            convo.push({
              role: "user",
              content:
                `github("${toolCall.query}") の結果:\n\n` +
                formatGithubForModel(repos) +
                `\n\n各リポジトリの特徴を詳しく述べる必要があれば、その` +
                ` URL を fetch_page で README を精読してください。` +
                `要点を踏まえて日本語で具体的に回答してください。`,
            });
          }
        }

        // MAX_STEPS 到達: 最後にもう一度、取得済み情報で回答を強制
        send({ kind: "phase", phase: "final", iter: MAX_STEPS });
        const finalRaw = await chatCompletion(convo);
        send({ kind: "step", step: { type: "final", text: finalRaw } });
        finish(finalRaw);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        send({ kind: "step", step: { type: "error", message } });
        finish("");
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
