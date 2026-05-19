# Tool Calling Demo

ローカル LLM (`gemma-4-e4b-it` / llama-server) に `web_search` /
`fetch_page` / `arxiv` / `github` ツールをプロンプトベース Tool calling で
持たせ、各ステップの内部動作を可視化するデモ。

検索バックエンドは API キー不要（`github` のみ任意で `GITHUB_TOKEN`）。

## アーキテクチャ

```
[Chat UI] ←SSE← [/api/chat (Tool callingループ)]
               ├─ llama-server /v1/chat/completions
               │    システムプロンプトで 4ツールの仕様を注入
               │    モデルが {"tool":"<name>","query|url":"..."} を出力
               ├─ web_search: SearXNG ?format=json を fetch (上位5件)
               ├─ fetch_page: URL を取得し本文テキストを抽出(最大4000字)
               ├─ arxiv     : arXiv API(Atom)。429/失敗時は OpenAlex に自動代替
               ├─ github    : GitHub リポジトリ検索(★順 上位5件)
               └─ 結果を会話に戻し最終回答までループ(最大6段)
```

`gemma-4-e4b-it` は OpenAI の `tools` パラメータに非対応のため、
「ツールを使う時は決まった JSON だけ出力せよ」と指示し、アプリ側で
その JSON を検出・実行するプロンプトベース方式を採用している。

## セットアップ

1. 環境変数を用意

   ```sh
   cp .env.example .env.local
   ```

2. SearXNG を起動（JSON API を有効化済み）

   ```sh
   docker compose up -d
   # 疎通確認: JSON が返れば OK
   curl 'http://localhost:8888/search?q=test&format=json' | head -c 100
   ```

3. llama-server を `http://localhost:8080` で起動（`gemma-4-e4b-it`）

4. 開発サーバ

   ```sh
   npm install
   npm run dev
   ```

   `http://localhost:3000` を開く。

## 構成

| パス | 役割 |
|---|---|
| `lib/web-search.ts` | `web_search` ツール実体（fetch・URLエンコード・結果整形） |
| `lib/fetch-page.ts` | `fetch_page` ツール実体（URL取得・本文テキスト抽出） |
| `lib/arxiv.ts` | `arxiv` ツール実体（arXiv API・Atom XML パース） |
| `lib/github.ts` | `github` ツール実体（GitHub リポジトリ検索・任意トークン） |
| `lib/llama.ts` | llama-server クライアント／仕様プロンプト／ツール JSON パーサ |
| `app/api/chat/route.ts` | Tool calling ループ(SSE)。各段を step として返す |
| `app/page.tsx` | ステップ可視化チャット UI＋ワークフロー図（回答は Markdown 表示） |
| `docker-compose.yml`, `searxng/settings.yml` | ローカル SearXNG |
