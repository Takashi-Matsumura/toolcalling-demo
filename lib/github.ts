// github ツールの実体。
// GitHub のリポジトリ検索 API を叩き、上位リポジトリの要点を返す。
// 認証なしでも動くが 10req/分 に制限される。GITHUB_TOKEN があれば
// 付与してレート制限を緩和する(任意)。

const GITHUB_API = "https://api.github.com/search/repositories";
const MAX_RESULTS = 5;

export type GithubRepo = {
  fullName: string;
  description: string;
  stars: number;
  language: string;
  url: string;
};

export async function githubSearch(query: string): Promise<GithubRepo[]> {
  const endpoint =
    `${GITHUB_API}?q=${encodeURIComponent(query)}` +
    `&sort=stars&order=desc&per_page=${MAX_RESULTS}`;

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "toolcalling-demo/1.0",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);

  try {
    const res = await fetch(endpoint, {
      signal: controller.signal,
      headers,
      cache: "no-store",
    });

    if (res.status === 403) {
      throw new Error(
        "GitHub API レート制限に達しました。" +
          ".env.local に GITHUB_TOKEN を設定すると緩和されます。",
      );
    }
    if (!res.ok) {
      throw new Error(`GitHub API 失敗 (HTTP ${res.status})`);
    }

    const data = (await res.json()) as {
      items?: {
        full_name?: string;
        description?: string | null;
        stargazers_count?: number;
        language?: string | null;
        html_url?: string;
      }[];
    };

    return (data.items ?? []).slice(0, MAX_RESULTS).map((r) => ({
      fullName: r.full_name ?? "",
      description: (r.description ?? "").trim(),
      stars: r.stargazers_count ?? 0,
      language: r.language ?? "",
      url: r.html_url ?? "",
    }));
  } finally {
    clearTimeout(timer);
  }
}

export function formatGithubForModel(repos: GithubRepo[]): string {
  if (repos.length === 0) {
    return "該当するリポジトリが見つかりませんでした。クエリを変えて再検索してください。";
  }
  return repos
    .map(
      (r, i) =>
        `[${i + 1}] ${r.fullName} (★${r.stars}, ${r.language || "言語不明"})\n` +
        `URL: ${r.url}\n説明: ${r.description || "(説明なし)"}`,
    )
    .join("\n\n");
}
