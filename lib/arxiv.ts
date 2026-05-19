// arxiv ツールの実体。学術論文を検索し要点だけ整形して LLM に返す。
//
// バックエンド戦略:
//   1. まず arXiv API (Atom XML) を試す。canonical で abs URL も取れる。
//   2. arXiv はバースト的アクセスに非常に厳しく 429/接続拒否を返すため、
//      失敗したら OpenAlex API (JSON・レート制限が緩い) にフォールバック。
//   どちらも API キー不要。

const ARXIV_API = "https://export.arxiv.org/api/query";
const OPENALEX_API = "https://api.openalex.org/works";
const MAX_RESULTS = 5;

export type ArxivPaper = {
  title: string;
  authors: string[];
  year: string;
  summary: string;
  url: string;
  source: "arxiv" | "openalex"; // どのバックエンドで取れたか(UI 表示用)
};

export async function arxivSearch(query: string): Promise<ArxivPaper[]> {
  try {
    const papers = await fromArxiv(query);
    if (papers.length > 0) return papers;
    // 0件なら OpenAlex も試す
    return await fromOpenAlex(query);
  } catch {
    // arXiv が 429/失敗 → OpenAlex にフォールバック
    return await fromOpenAlex(query);
  }
}

async function fromArxiv(query: string): Promise<ArxivPaper[]> {
  const endpoint =
    `${ARXIV_API}?search_query=${encodeURIComponent("all:" + query)}` +
    `&start=0&max_results=${MAX_RESULTS}&sortBy=relevance`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(endpoint, {
      signal: controller.signal,
      headers: { "User-Agent": "toolcalling-demo/1.0" },
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(`arXiv API 失敗 (HTTP ${res.status})`);
    }
    return parseEntries(await res.text());
  } finally {
    clearTimeout(timer);
  }
}

async function fromOpenAlex(query: string): Promise<ArxivPaper[]> {
  const endpoint =
    `${OPENALEX_API}?search=${encodeURIComponent(query)}` +
    `&per_page=${MAX_RESULTS}&mailto=takashimats@icloud.com`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(endpoint, {
      signal: controller.signal,
      headers: { "User-Agent": "toolcalling-demo/1.0" },
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(`OpenAlex API 失敗 (HTTP ${res.status})`);
    }
    const data = (await res.json()) as { results?: OpenAlexWork[] };
    return (data.results ?? []).slice(0, MAX_RESULTS).map((w) => ({
      title: (w.display_name ?? "").trim(),
      authors: (w.authorships ?? [])
        .map((a) => a.author?.display_name ?? "")
        .filter(Boolean),
      year: w.publication_year ? String(w.publication_year) : "",
      summary: invertedToText(w.abstract_inverted_index).slice(0, 300),
      url:
        w.primary_location?.landing_page_url ||
        w.doi ||
        w.id ||
        "",
      source: "openalex" as const,
    }));
  } finally {
    clearTimeout(timer);
  }
}

type OpenAlexWork = {
  id?: string;
  doi?: string;
  display_name?: string;
  publication_year?: number;
  primary_location?: { landing_page_url?: string };
  authorships?: { author?: { display_name?: string } }[];
  abstract_inverted_index?: Record<string, number[]>;
};

// OpenAlex の abstract は語→出現位置の転置インデックスで来る。元の文に戻す。
function invertedToText(idx?: Record<string, number[]>): string {
  if (!idx) return "(要約なし)";
  const slots: string[] = [];
  for (const [word, positions] of Object.entries(idx)) {
    for (const p of positions) slots[p] = word;
  }
  return slots.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function parseEntries(xml: string): ArxivPaper[] {
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
  return entries.map((e) => {
    const title = pick(e, "title").replace(/\s+/g, " ").trim();
    const summary = pick(e, "summary").replace(/\s+/g, " ").trim();
    const published = pick(e, "published");
    const authors = [...e.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) =>
      m[1].trim(),
    );
    // <id> は abs ページの URL (例: http://arxiv.org/abs/xxxx)
    const url = pick(e, "id").trim();
    return {
      title,
      authors,
      year: published.slice(0, 4),
      summary: summary.slice(0, 300),
      url,
      source: "arxiv" as const,
    };
  });
}

function pick(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1] : "";
}

export function formatArxivForModel(papers: ArxivPaper[]): string {
  if (papers.length === 0) {
    return "該当する論文が見つかりませんでした。クエリを変えて再検索してください。";
  }
  return papers
    .map(
      (p, i) =>
        `[${i + 1}] ${p.title} (${p.year})\n` +
        `著者: ${p.authors.slice(0, 4).join(", ")}\n` +
        `URL: ${p.url}\n概要: ${p.summary}`,
    )
    .join("\n\n");
}
