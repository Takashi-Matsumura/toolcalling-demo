// fetch_page ツールの実体。
// 指定 URL を取得し、本文テキストを抽出して LLM が読める形に整える。
//
// 注意(学習者向け): ここは静的 HTML を取得して素朴にタグ除去するだけ。
// JavaScript で描画されるサイト(SPA 等)は本文が取れないことがある。
// その場合 LLM は別 URL を fetch_page し直す想定。

const MAX_CHARS = 4000; // LLM コンテキスト保護のため上限

export type FetchPageResult = {
  url: string;
  ok: boolean;
  chars: number;
  text: string;
};

export async function fetchPage(url: string): Promise<FetchPageResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        // 一般的なブラウザ UA。素の fetch だと弾くサイトがあるため。
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
      cache: "no-store",
    });

    if (!res.ok) {
      return { url, ok: false, chars: 0, text: `HTTP ${res.status} で取得失敗` };
    }

    const html = await res.text();
    const text = extractText(html);
    const clipped = text.slice(0, MAX_CHARS);
    return {
      url,
      ok: clipped.length > 0,
      chars: clipped.length,
      text:
        clipped.length > 0
          ? clipped
          : "本文テキストを抽出できませんでした(JS 描画ページの可能性)。",
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { url, ok: false, chars: 0, text: `取得エラー: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

// HTML から可読テキストを素朴に抽出する。
function extractText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
