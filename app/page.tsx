"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertTriangle,
  Brain,
  Check,
  Globe,
  Reply,
  RotateCcw,
  Trash2,
  Wrench,
  type LucideIcon,
} from "lucide-react";

// Tool calling の各段をチャットに表示しつつ、横のワークフロー図で
// web_search ツールの Step 実行をライブに可視化する。

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

type Phase = "llm" | "tool_call" | "search" | "feedback" | "final";

type StreamEvent =
  | { kind: "phase"; phase: Phase; iter: number }
  | { kind: "step"; step: Step }
  | { kind: "answer"; answer: string }
  | { kind: "done" };

type Turn = {
  user: string;
  steps: Step[];
  answer: string;
};

type WorkflowState = {
  phase: Phase | null;
  iter: number;
  query: string;
  resultCount: number | null;
  status: "idle" | "running" | "error" | "done";
};

const IDLE_WF: WorkflowState = {
  phase: null,
  iter: 0,
  query: "",
  resultCount: null,
  status: "idle",
};

export default function Home() {
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [live, setLive] = useState<Turn | null>(null);
  const [wf, setWf] = useState<WorkflowState>(IDLE_WF);
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns, live, loading]);

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    setLoading(true);

    const history = turns.flatMap((t) => [
      { role: "user" as const, content: t.user },
      { role: "assistant" as const, content: t.answer },
    ]);

    const liveTurn: Turn = { user: text, steps: [], answer: "" };
    setLive({ ...liveTurn });
    setWf({ ...IDLE_WF, status: "running" });

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [...history, { role: "user", content: text }],
        }),
      });

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // SSE は \n\n 区切り。完成したイベントだけ処理する。
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";

        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          const ev = JSON.parse(line.slice(5).trim()) as StreamEvent;

          if (ev.kind === "phase") {
            setWf((w) => ({
              ...w,
              phase: ev.phase,
              iter: ev.iter,
              status: "running",
            }));
          } else if (ev.kind === "step") {
            const step = ev.step;
            liveTurn.steps = [...liveTurn.steps, step];
            setLive({ ...liveTurn });
            if (step.type === "tool_call") {
              setWf((w) => ({ ...w, query: step.query }));
            } else if (step.type === "tool_result") {
              setWf((w) => ({ ...w, resultCount: step.results.length }));
            } else if (step.type === "error") {
              setWf((w) => ({ ...w, status: "error" }));
            }
          } else if (ev.kind === "answer") {
            liveTurn.answer = ev.answer;
            setLive({ ...liveTurn });
          } else if (ev.kind === "done") {
            setTurns((prev) => [...prev, { ...liveTurn }]);
            setLive(null);
            setWf((w) => ({
              ...w,
              phase: null,
              status: w.status === "error" ? "error" : "done",
            }));
          }
        }
      }
    } catch (e) {
      liveTurn.steps = [
        ...liveTurn.steps,
        { type: "error", message: e instanceof Error ? e.message : String(e) },
      ];
      setTurns((prev) => [...prev, { ...liveTurn }]);
      setLive(null);
      setWf((w) => ({ ...w, status: "error", phase: null }));
    } finally {
      setLoading(false);
    }
  }

  function clearChat() {
    if (loading) return;
    setTurns([]);
    setLive(null);
    setWf(IDLE_WF);
    setInput("");
  }

  const allTurns = live ? [...turns, live] : turns;
  const hasContent = turns.length > 0 || live !== null;

  return (
    <main className="mx-auto flex h-screen w-full max-w-6xl gap-6 px-4">
      {/* 左: チャット */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="shrink-0 py-6">
          <div className="flex items-start justify-between gap-4">
            <h1 className="text-2xl font-semibold tracking-tight">
              Tool Calling Demo
            </h1>
            <button
              onClick={clearChat}
              disabled={loading || !hasContent}
              title="チャットをクリア"
              className="flex shrink-0 items-center gap-1.5 rounded-full border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              <Trash2 size={15} />
              クリア
            </button>
          </div>
          <p className="mt-1 text-sm text-zinc-500">
            ローカル LLM (gemma-4-e4b-it) +{" "}
            <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">
              web_search
            </code>{" "}
            ツール。右のワークフロー図で Step 実行をライブ表示します。
          </p>
        </header>

        <div className="flex flex-1 flex-col gap-8 overflow-y-auto pb-6">
          {allTurns.map((t, i) => (
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

        <div className="flex shrink-0 gap-2 border-t border-zinc-200 bg-white py-4 dark:border-zinc-800 dark:bg-black">
          <input
            className="flex-1 rounded-full border border-zinc-300 px-4 py-2 outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-900"
            value={input}
            placeholder="例: Next.js 16 の新機能を調べて"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
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
      </div>

      {/* 右: ワークフロー可視化 */}
      <aside className="hidden w-80 shrink-0 overflow-y-auto py-6 lg:block">
        <WorkflowPanel wf={wf} />
      </aside>
    </main>
  );
}

const PHASES: { id: Phase; label: string; desc: string; icon: LucideIcon }[] = [
  { id: "llm", label: "LLM 推論", desc: "ツールを使うか判断", icon: Brain },
  {
    id: "tool_call",
    label: "ツール呼び出し",
    desc: "web_search(query) を要求",
    icon: Wrench,
  },
  {
    id: "search",
    label: "SearXNG 検索",
    desc: "HTTP で検索を実行",
    icon: Globe,
  },
  {
    id: "feedback",
    label: "結果を会話へ反映",
    desc: "整形して LLM に戻す",
    icon: Reply,
  },
  { id: "final", label: "最終回答", desc: "回答を生成", icon: Check },
];

function WorkflowPanel({ wf }: { wf: WorkflowState }) {
  const activeIdx = wf.phase
    ? PHASES.findIndex((p) => p.id === wf.phase)
    : -1;

  function nodeStatus(idx: number): "idle" | "active" | "done" | "error" {
    if (wf.status === "error" && idx === activeIdx) return "error";
    if (wf.status === "idle") return "idle";
    if (wf.status === "done") return "done";
    if (activeIdx === -1) return "idle";
    if (idx < activeIdx) return "done";
    if (idx === activeIdx) return "active";
    return "idle";
  }

  return (
    <div className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="font-semibold">web_search ワークフロー</h2>
        {wf.iter > 0 && (
          <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-950 dark:text-blue-300">
            ループ #{wf.iter}
          </span>
        )}
      </div>
      <p className="mb-4 text-xs text-zinc-500">
        {wf.status === "running"
          ? "実行中…"
          : wf.status === "done"
            ? "完了"
            : wf.status === "error"
              ? "エラーで停止"
              : "メッセージ送信で開始"}
      </p>

      <ol className="relative flex flex-col gap-1">
        {PHASES.map((p, idx) => {
          const st = nodeStatus(idx);
          const Icon =
            st === "done" ? Check : st === "error" ? AlertTriangle : p.icon;
          return (
            <li key={p.id} className="flex gap-3">
              {/* ノード + 縦線 */}
              <div className="flex flex-col items-center">
                <span
                  className={[
                    "flex h-9 w-9 items-center justify-center rounded-full border-2 text-sm transition-colors",
                    st === "active"
                      ? "animate-pulse border-blue-500 bg-blue-500 text-white"
                      : st === "done"
                        ? "border-emerald-500 bg-emerald-500 text-white"
                        : st === "error"
                          ? "border-red-500 bg-red-500 text-white"
                          : "border-zinc-300 bg-transparent text-zinc-400 dark:border-zinc-700",
                  ].join(" ")}
                >
                  <Icon size={18} strokeWidth={2.2} />
                </span>
                {idx < PHASES.length - 1 && (
                  <span
                    className={[
                      "my-1 w-0.5 flex-1 transition-colors",
                      idx < activeIdx || wf.status === "done"
                        ? "bg-emerald-500"
                        : "bg-zinc-200 dark:bg-zinc-700",
                    ].join(" ")}
                    style={{ minHeight: "1.5rem" }}
                  />
                )}
              </div>

              {/* ラベル */}
              <div className="pb-3 pt-1">
                <div
                  className={[
                    "text-sm font-medium",
                    st === "active"
                      ? "text-blue-600 dark:text-blue-400"
                      : st === "idle"
                        ? "text-zinc-400"
                        : "",
                  ].join(" ")}
                >
                  {p.label}
                </div>
                <div className="text-xs text-zinc-500">{p.desc}</div>

                {p.id === "tool_call" && wf.query && (
                  <div className="mt-1 truncate rounded bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                    query: {wf.query}
                  </div>
                )}
                {p.id === "search" && wf.resultCount !== null && (
                  <div className="mt-1 rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                    {wf.resultCount} 件取得
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <div className="mt-2 flex items-start gap-2 rounded-lg bg-zinc-50 p-2 text-xs text-zinc-500 dark:bg-zinc-900">
        <RotateCcw size={14} className="mt-0.5 shrink-0" />
        <span>
          「結果を会話へ反映」後、LLM が再度ツールを要求すると LLM
          推論へ戻りループします（最大 4 回）。
        </span>
      </div>
    </div>
  );
}

function StepView({ step }: { step: Step }) {
  if (step.type === "llm_raw") {
    return (
      <details className="rounded-lg border border-zinc-200 px-3 py-2 text-xs dark:border-zinc-700">
        <summary className="cursor-pointer text-zinc-500">LLM 生出力</summary>
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

  return null;
}
