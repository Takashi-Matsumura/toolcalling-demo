"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Tool calling の各段(LLM生出力 → ツール呼出 → 結果 → 最終回答)を
// そのまま画面に出す。学習用途なので「中で何が起きているか」を隠さない。

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

type Turn = {
  user: string;
  steps: Step[];
  answer: string;
};

export default function Home() {
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns, loading]);

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    setLoading(true);

    // 会話履歴(ユーザー可視分)をサーバへ
    const history = turns.flatMap((t) => [
      { role: "user" as const, content: t.user },
      { role: "assistant" as const, content: t.answer },
    ]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [...history, { role: "user", content: text }],
        }),
      });
      const data = (await res.json()) as {
        steps: Step[];
        answer: string;
        error?: string;
      };
      setTurns((prev) => [
        ...prev,
        { user: text, steps: data.steps ?? [], answer: data.answer },
      ]);
    } catch (e) {
      setTurns((prev) => [
        ...prev,
        {
          user: text,
          steps: [
            {
              type: "error",
              message: e instanceof Error ? e.message : String(e),
            },
          ],
          answer: "",
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto flex h-screen w-full max-w-3xl flex-col px-4">
      <header className="shrink-0 py-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          Tool Calling Demo
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          ローカル LLM (gemma-4-e4b-it) +{" "}
          <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">
            web_search
          </code>{" "}
          ツール。各ステップの内部動作を表示します。
        </p>
      </header>

      <div className="flex flex-1 flex-col gap-8 overflow-y-auto pb-6">
        {turns.map((t, i) => (
          <div key={i} className="flex flex-col gap-3">
            <div className="self-end rounded-2xl bg-blue-600 px-4 py-2 text-white">
              {t.user}
            </div>

            {t.steps.map((s, j) => (
              <StepView key={j} step={s} />
            ))}

            {t.answer && (
              <div className="markdown rounded-2xl bg-zinc-100 px-4 py-3 dark:bg-zinc-800">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {t.answer}
                </ReactMarkdown>
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div className="text-sm text-zinc-500">推論中…</div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="shrink-0 flex gap-2 border-t border-zinc-200 bg-white py-4 dark:border-zinc-800 dark:bg-black">
        <input
          className="flex-1 rounded-full border border-zinc-300 px-4 py-2 outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-900"
          value={input}
          placeholder="例: Next.js 16 の新機能を調べて"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // 日本語入力中(変換確定)の Enter は送信しない
            if (e.key === "Enter" && !e.nativeEvent.isComposing) send();
          }}
          disabled={loading}
        />
        <button
          className="rounded-full bg-blue-600 px-5 py-2 font-medium text-white disabled:opacity-50"
          onClick={send}
          disabled={loading}
        >
          送信
        </button>
      </div>
    </main>
  );
}

function StepView({ step }: { step: Step }) {
  if (step.type === "llm_raw") {
    return (
      <details className="rounded-lg border border-zinc-200 px-3 py-2 text-xs dark:border-zinc-700">
        <summary className="cursor-pointer text-zinc-500">
          LLM 生出力
        </summary>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-zinc-600 dark:text-zinc-400">
          {step.content}
        </pre>
      </details>
    );
  }

  if (step.type === "tool_call") {
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm dark:border-amber-700 dark:bg-amber-950">
        🔧 <strong>web_search</strong> を呼び出し: <code>{step.query}</code>
      </div>
    );
  }

  if (step.type === "tool_result") {
    return (
      <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm dark:border-emerald-700 dark:bg-emerald-950">
        <div className="mb-2 text-emerald-700 dark:text-emerald-400">
          📄 検索結果 {step.results.length} 件
        </div>
        <ul className="flex flex-col gap-2">
          {step.results.map((r, i) => (
            <li key={i}>
              <a
                href={r.url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-blue-600 underline"
              >
                {r.title}
              </a>
              <p className="text-xs text-zinc-500">{r.snippet}</p>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (step.type === "error") {
    return (
      <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-400">
        ⚠ {step.message}
      </div>
    );
  }

  // final はバブルとして別途表示するのでここでは何も出さない
  return null;
}
