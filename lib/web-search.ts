// web_search ツールの実体。
// LLM は「web_search(query) を呼びたい」と要求するだけ。
// curl 相当の HTTP リクエスト・URL エンコード・結果整形はすべてここで行う。
// = Tool calling の「アプリ側が実行を担当する」部分。

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

const SEARXNG_URL = process.env.SEARXNG_URL ?? "http://localhost:8888";
const MAX_RESULTS = 5;

export async function webSearch(query: string): Promise<SearchResult[]> {
  // クエリは必ず URL エンコードする (生の空白・日本語で壊れる典型)
  const endpoint = `${SEARXNG_URL}/search?q=${encodeURIComponent(
    query,
  )}&format=json`;

  const res = await fetch(endpoint, {
    headers: { Accept: "application/json" },
    // 学習デモなのでキャッシュは無効化し常に実検索
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(
      `SearXNG への検索に失敗しました (HTTP ${res.status}). ` +
        `docker compose up -d で SearXNG が起動しているか確認してください。`,
    );
  }

  const data = (await res.json()) as {
    results?: { title?: string; url?: string; content?: string }[];
  };

  // 生のレスポンスをそのまま LLM に渡さない。
  // タイトル+URL+スニペットだけに削り、上位 N 件に絞る。
  return (data.results ?? [])
    .filter((r) => r.url && r.title)
    .slice(0, MAX_RESULTS)
    .map((r) => ({
      title: (r.title ?? "").trim(),
      url: (r.url ?? "").trim(),
      snippet: (r.content ?? "").trim().slice(0, 300),
    }));
}

// 検索結果を LLM に戻すためのテキスト表現。
export function formatResultsForModel(results: SearchResult[]): string {
  if (results.length === 0) {
    return "検索結果は0件でした。クエリを変えて再検索するか、その旨をユーザーに伝えてください。";
  }
  return results
    .map(
      (r, i) =>
        `[${i + 1}] ${r.title}\nURL: ${r.url}\n概要: ${r.snippet}`,
    )
    .join("\n\n");
}
