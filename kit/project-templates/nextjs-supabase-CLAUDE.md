# <プロジェクト名>

> このファイルはプロジェクト直下に `CLAUDE.md` として置く。
> **技術構成と、このプロジェクト固有の事情だけ**を書く。
> 安全ルールは `~/.claude/CLAUDE.md`（共通）にある。ここに複製しないこと。

---

## 何のサービスか

<1〜3 行。誰の、どの手間を、どう減らすものか。機能一覧ではなく目的を書く>

## 本番 URL / 環境

| | |
|---|---|
| 本番 | https://example.com |
| プレビュー | Vercel の PR ごとのプレビュー |
| Supabase プロジェクト | `<project-ref>`（本番）／`<project-ref>`（開発） |

## 技術構成

- Next.js App Router（`app/` 配下）／TypeScript
- Supabase（Postgres + Auth + Storage）
- Vercel（本番・プレビュー）
- Resend（メール送信）
- Anthropic Claude API（<使っている場所>）

## ディレクトリ

```
app/                 ルート。(ja)/(en) のルートグループで言語を分ける
  api/               Route Handlers
components/          UI。article/ など用途別に切る
lib/                 supabase クライアント、schema.ts、共通ロジック
supabase/migrations/ マイグレーション。手で DB を触らずここに残す
```

## コマンド

```bash
npm run dev
npm run build      # 型エラーはここで落ちる。push 前に必ず通す
npm run lint
```

## このプロジェクト固有の決めごと

- <例: JSON-LD はサーバーコンポーネントの素の `<script>` で出す。`next/script` は SSR の HTML に残らない>
- <例: `metadataBase` が apex だが配信は www。canonical は www 付き絶対 URL で書く>
- <例: 金額に関わる箇所は `lib/pricing.ts` を単一の定義元とする>

## 触ってはいけないもの

- `supabase/migrations/` の既存ファイル（新規追加のみ）
- <例: `lib/schema.ts` の Person ノードの `@id`。外部から参照されている>

## 既知の落とし穴

- <過去に踏んだものを書く。ここが一番価値のあるセクション>
