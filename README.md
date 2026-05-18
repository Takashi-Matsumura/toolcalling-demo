# Tool Calling Demo

ローカル LLM (`gemma-4-e4b-it` / llama-server) に `web_search` ツールを
プロンプトベース Tool calling で持たせ、各ステップの内部動作を可視化するデモ。

検索バックエンドは API キー不要のローカル SearXNG（Docker）。

## アーキテクチャ

```
[Chat UI] → [/api/chat (Tool callingループ)]
               ├─ llama-server /v1/chat/completions
               │    システムプロンプトで web_search 仕様を注入
               │    モデルが {"tool":"web_search","query":"..."} を出力
               ├─ web_search 実装: SearXNG ?format=json を fetch
               │    タイトル+URL+スニペットを上位5件に整形
               └─ 結果を会話に戻し最終回答までループ(最大4段)
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
| `lib/llama.ts` | llama-server クライアント／仕様プロンプト／ツール JSON パーサ |
| `app/api/chat/route.ts` | Tool calling ループ。各段を step として返す |
| `app/page.tsx` | ステップ可視化チャット UI（回答は Markdown 表示） |
| `docker-compose.yml`, `searxng/settings.yml` | ローカル SearXNG |
