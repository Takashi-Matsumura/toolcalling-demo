// arxiv ツールの実体。
// arXiv API (Atom XML) を叩き、論文の要点だけに整形して LLM に返す。
// 依存を増やさず、fetch-page.ts と同様に素朴な正規表現で抽出する。

const ARXIV_API = "https://export.arxiv.org/api/query";
const MAX_RESULTS = 5;

export type ArxivPaper = {
  title: string;
  authors: string[];
  year: string;
  summary: string;
  url: string;
};

export async function arxivSearch(query: string): Promise<ArxivPaper[]> {
  const endpoint =
    `${ARXIV_API}?search_query=${encodeURIComponent("all:" + query)}` +
    `&start=0&max_results=${MAX_RESULTS}&sortBy=relevance`;

  // arXiv はバースト的なアクセスに厳しく 429 を返す。
  // 1度だけ短い待機を挟んでリトライする。
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const res = await fetch(endpoint, {
        signal: controller.signal,
        headers: { "User-Agent": "toolcalling-demo/1.0" },
        cache: "no-store",
      });
      if (res.status === 429) {
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        throw new Error(
          "arXiv API がレート制限中です(HTTP 429)。" +
            "数十秒おいて再試行してください。",
        );
      }
      if (!res.ok) {
        throw new Error(`arXiv API 失敗 (HTTP ${res.status})`);
      }
      const xml = await res.text();
      return parseEntries(xml);
    } finally {
      clearTimeout(timer);
    }
  }
  // 到達しない (上で必ず return か throw する)
  return [];
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
