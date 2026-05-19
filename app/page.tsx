"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertTriangle,
  Brain,
  Check,
  FileText,
  Search,
  Trash2,
  type LucideIcon,
} from "lucide-react";

// Tool calling の各段をチャットに表示しつつ、横のワークフロー図で
// 各ループ(LLM 推論→ツール)の履歴を積み上げて可視化する。

type Step =
  | { type: "llm_raw"; content: string }
  | { type: "tool_call"; tool: "web_search" | "fetch_page"; arg: string }
  | {
      type: "search_result";
      query: string;
      results: { title: string; url: string; snippet: string }[];
    }
  | { type: "fetch_result"; url: string; ok: boolean; chars: number }
  | { type: "final"; text: string }
  | { type: "error"; message: string };

type Phase = "llm" | "tool_call" | "tool_exec" | "feedback" | "final";

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

// 1ループ分の記録。これを配列で積むことで履歴を見せる。
type LoopIter = {
  n: number;
  kind: "pending" | "tool" | "answer";
  phase: Phase | null;
  tool: "web_search" | "fetch_page" | null;
  arg: string;
  resultCount: number | null;
  fetchChars: number | null;
  fetchOk: boolean | null;
  status: "running" | "done" | "error";
};

type WorkflowState = {
  iters: LoopIter[];
  status: "idle" | "running" | "error" | "done";
};

const IDLE_WF: WorkflowState = { iters: [], status: "idle" };

const PHASE_LABEL: Record<Phase, string> = {
  llm: "LLM 推論中…",
  tool_call: "ツール呼び出しを生成…",
  tool_exec: "ツール実行中…",
  feedback: "結果を会話へ反映…",
  final: "最終回答を生成…",
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

  // 直近(=実行中)のループを書き換えるヘルパー。
  function patchLast(
    w: WorkflowState,
    fn: (it: LoopIter) => LoopIter,
  ): WorkflowState {
    if (w.iters.length === 0) return w;
    const iters = w.iters.slice();
    iters[iters.length - 1] = fn(iters[iters.length - 1]);
    return { ...w, iters };
  }

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
    setWf({ iters: [], status: "running" });

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

        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";

        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          const ev = JSON.parse(line.slice(5).trim()) as StreamEvent;

          if (ev.kind === "phase") {
            setWf((w) => {
              const last = w.iters[w.iters.length - 1];
              if (!last || last.n !== ev.iter) {
                // 新しいループの開始: 前ループを done にして新規追加
                const iters = w.iters.map((it) =>
                  it.status === "running"
                    ? { ...it, status: "done" as const }
                    : it,
                );
                iters.push({
                  n: ev.iter,
                  kind: ev.phase === "final" ? "answer" : "pending",
                  phase: ev.phase,
                  tool: null,
                  arg: "",
                  resultCount: null,
                  fetchChars: null,
                  fetchOk: null,
                  status: "running",
                });
                return { ...w, iters };
              }
              // 同一ループ内のフェーズ更新
              return patchLast(w, (it) => ({
                ...it,
                phase: ev.phase,
                kind:
                  ev.phase === "final"
                    ? "answer"
                    : ev.phase === "tool_call"
                      ? "tool"
                      : it.kind,
              }));
            });
          } else if (ev.kind === "step") {
            const step = ev.step;
            liveTurn.steps = [...liveTurn.steps, step];
            setLive({ ...liveTurn });
            if (step.type === "tool_call") {
              setWf((w) =>
                patchLast(w, (it) => ({
                  ...it,
                  kind: "tool",
                  tool: step.tool,
                  arg: step.arg,
                })),
              );
            } else if (step.type === "search_result") {
              setWf((w) =>
                patchLast(w, (it) => ({
                  ...it,
                  resultCount: step.results.length,
                })),
              );
            } else if (step.type === "fetch_result") {
              setWf((w) => {
                const patched = patchLast(w, (it) => ({
                  ...it,
                  fetchChars: step.chars,
                  fetchOk: step.ok,
                  status: step.ok ? it.status : ("error" as const),
                }));
                return step.ok
                  ? patched
                  : { ...patched, status: "error" as const };
              });
            } else if (step.type === "error") {
              setWf((w) => ({
                ...patchLast(w, (it) => ({ ...it, status: "error" })),
                status: "error",
              }));
            }
          } else if (ev.kind === "answer") {
            liveTurn.answer = ev.answer;
            setLive({ ...liveTurn });
          } else if (ev.kind === "done") {
            setTurns((prev) => [...prev, { ...liveTurn }]);
            setLive(null);
            setWf((w) => ({
              status: w.status === "error" ? "error" : "done",
              iters: w.iters.map((it) =>
                it.status === "running"
                  ? { ...it, status: "done" as const }
                  : it,
              ),
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
      setWf((w) => ({ ...w, status: "error" }));
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
            /{" "}
            <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">
              fetch_page
            </code>{" "}
            ツール。右にツール実行ループの履歴を表示します。
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

          {loading && <div className="text-sm text-zinc-500">推論中…</div>}
          <div ref={bottomRef} />
        </div>

        <div className="flex shrink-0 gap-2 border-t border-zinc-200 bg-white py-4 dark:border-zinc-800 dark:bg-black">
          <input
            className="flex-1 rounded-full border border-zinc-300 px-4 py-2 outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-900"
            value={input}
            placeholder="例: 沖縄市の今日の天気を教えて"
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

      {/* 右: ループ履歴の可視化 */}
      <aside className="hidden w-80 shrink-0 overflow-y-auto py-6 lg:block">
        <WorkflowPanel wf={wf} />
      </aside>
    </main>
  );
}

function WorkflowPanel({ wf }: { wf: WorkflowState }) {
  return (
    <div className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="font-semibold">ツール実行ループ履歴</h2>
        {wf.iters.length > 0 && (
          <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-950 dark:text-blue-300">
            {wf.iters.length} ループ
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

      {wf.iters.length === 0 ? (
        <p className="rounded-lg bg-zinc-50 p-3 text-xs text-zinc-500 dark:bg-zinc-900">
          各ループで LLM が web_search / fetch_page
          を呼んだ履歴がここに順番に積み上がります。
        </p>
      ) : (
        <ol className="flex flex-col">
          {wf.iters.map((it, idx) => (
            <li key={it.n} className="flex gap-3">
              <div className="flex flex-col items-center">
                <IterBadge it={it} />
                {idx < wf.iters.length - 1 && (
                  <span
                    className="my-1 w-0.5 flex-1 bg-zinc-200 dark:bg-zinc-700"
                    style={{ minHeight: "1.25rem" }}
                  />
                )}
              </div>
              <IterCard it={it} />
            </li>
          ))}
        </ol>
      )}

      <div className="mt-3 rounded-lg bg-zinc-50 p-2 text-xs text-zinc-500 dark:bg-zinc-900">
        LLM がツールを繰り返し要求するたびに新しいループが追加されます
        （最大 5 回）。検索 → 本文取得 → 回答、のように連鎖します。
      </div>
    </div>
  );
}

function iterIcon(it: LoopIter): LucideIcon {
  if (it.status === "error") return AlertTriangle;
  if (it.kind === "answer") return Check;
  if (it.tool === "fetch_page") return FileText;
  if (it.tool === "web_search") return Search;
  return Brain;
}

function IterBadge({ it }: { it: LoopIter }) {
  const Icon = iterIcon(it);
  const cls =
    it.status === "running"
      ? "animate-pulse border-blue-500 bg-blue-500 text-white"
      : it.status === "error"
        ? "border-red-500 bg-red-500 text-white"
        : "border-emerald-500 bg-emerald-500 text-white";
  return (
    <span
      className={`flex h-9 w-9 items-center justify-center rounded-full border-2 ${cls}`}
    >
      <Icon size={17} strokeWidth={2.2} />
    </span>
  );
}

function IterCard({ it }: { it: LoopIter }) {
  const title =
    it.kind === "answer"
      ? "最終回答を生成"
      : it.tool === "web_search"
        ? "web_search で検索"
        : it.tool === "fetch_page"
          ? "fetch_page で本文取得"
          : "LLM 推論";

  return (
    <div className="min-w-0 pb-4 pt-1">
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
          ループ #{it.n}
        </span>
        <span
          className={[
            "text-sm font-medium",
            it.status === "running" ? "text-blue-600 dark:text-blue-400" : "",
            it.status === "error" ? "text-red-600 dark:text-red-400" : "",
          ].join(" ")}
        >
          {title}
        </span>
      </div>

      {it.tool && it.arg && (
        <div className="mt-1 truncate rounded bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          {it.tool}: {it.arg}
        </div>
      )}

      {it.resultCount !== null && (
        <div className="mt-1 rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
          検索結果 {it.resultCount} 件取得
        </div>
      )}

      {it.fetchChars !== null && (
        <div
          className={[
            "mt-1 rounded px-2 py-1 text-xs",
            it.fetchOk
              ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
              : "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-400",
          ].join(" ")}
        >
          {it.fetchOk
            ? `本文 ${it.fetchChars} 文字抽出`
            : "本文取得に失敗"}
        </div>
      )}

      {it.status === "running" && it.phase && (
        <div className="mt-1 text-xs text-blue-600 dark:text-blue-400">
          {PHASE_LABEL[it.phase]}
        </div>
      )}
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
    const isFetch = step.tool === "fetch_page";
    return (
      <div className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm dark:border-amber-700 dark:bg-amber-950">
        {isFetch ? <FileText size={15} /> : <Search size={15} />}
        <span>
          <strong>{step.tool}</strong> を呼び出し: <code>{step.arg}</code>
        </span>
      </div>
    );
  }

  if (step.type === "search_result") {
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

  if (step.type === "fetch_result") {
    return (
      <div
        className={[
          "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm",
          step.ok
            ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
            : "border-red-300 bg-red-50 text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-400",
        ].join(" ")}
      >
        <FileText size={15} />
        <span className="min-w-0">
          {step.ok
            ? `本文 ${step.chars} 文字を抽出`
            : "本文を取得できませんでした"}
          <span className="block truncate text-xs opacity-70">{step.url}</span>
        </span>
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
