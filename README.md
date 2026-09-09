# AI Workforce

**非エンジニアが 1 人で、本番稼働するプロダクトを複数本まわすための運用一式。**

コードを書くのは AI。人間がやるのは、判断と、AI が事故らないための機械的な歯止めを敷くこと。
このリポジトリは、その「歯止め」と「段取り」を、動く形で公開しています。

> **正直な断り書き。** 中身は、本番を守っている構成を**公開用に書き起こしたもの**です。
> 手元で動いている実物そのものではありません。このブランチは修正の統合検証中です。
> Linux / Node の検証結果と、Windows・CI・実機で残る確認は [統合状況](docs/17-integration-status.md) を参照してください。

日本語が正本です / [English summary](README.en.md)

---

まず1つだけ試す場合は、[SQLガード単体の最小手順](docs/14-try-guard-sql.md)へ。
既存設定を変更せず、データベースへの接続も不要です。
既存設定がある場合は、[フックだけ取り込む手順](docs/16-merge-existing-settings.md)へ。
導入後に戻す場合は、[復元手順](docs/15-restore-after-install.md)を参照してください。

## これは何か

- Claude Code / Cowork を **業務として** まわすための設定・フック・スクリプト・運用ルール一式
- そのまま `~/.claude/` に置いて動くもの（Windows / macOS / Linux）
- 「AI にコードを書かせてみた」の記事ではなく、**動いて、落ちるコード**。設計は、壊れると本番が止まる場所で使っているもの

## これは何ではないか

- エージェントフレームワークではありません（crewAI や AutoGen の代わりにはなりません）
- プロンプト集ではありません
- 「AI ですべてが終わる」という主張ではありません。むしろ**終わらない 2 割**をどう扱うかの話です

---

## なぜこれを公開するのか

AI で開発した話は無数にあります。動いている本番プロダクトの話は、それより桁違いに少ない。

私は 13 年ホテル・旅館の支配人をしていて、エンジニアではありません。
それでも Next.js + Supabase + Vercel で複数のサービスを本番運用しています。
できている理由は、私の腕ではなく、**AI に任せる範囲と、絶対に任せない範囲を機械で分けようとしている**からです。
分け切れてはいません。塞げていない場所は[そう書いてあります](docs/03-division-of-labor.md)。

その分け方を全部出します。無料・MIT・改変自由。

---

## 8:2

| 割合 | 誰が | 何を |
|---|---|---|
| 8 | AI | コードを書く / 調べる / 直す / テストを通す |
| 2 | 人間 | 何を作るか決める / 本番に触る前に止める / 責任を取る |

この 2 割が抜けると、速度は出ても本番が壊れます。
このリポジトリの中身は、ほぼ全部この「2 割」を機械化するためのものです。

---

## 4 本柱

### 1. 2 層の CLAUDE.md

安全ルールは全案件共通（`~/.claude/CLAUDE.md`）、技術構成は案件ごと（`<project>/CLAUDE.md`）。
混ぜるとルールが案件ごとに劣化するので、分けています。

→ [docs/01-two-layer-claude-md.md](docs/01-two-layer-claude-md.md)

### 2. 機械的な歯止め

「気をつける」では止まりません。PreToolUse フックで、実行前に落とします。

- `DROP` / `TRUNCATE`
- `WHERE` のない `UPDATE` / `DELETE`
- DDL 全般（内容を提示して承認を取るまで実行させない。フックは接続先を見ないので、開発 DB でも同じく落ちます）

DDL は「人間が承認したその文が、15 分だけ、1 回だけ通る」。
文が 1 文字違えば通りません。

誤検知しないことの方が大事なので、テストは「止まるべきもの」と
「止まってはいけないもの」を両方見ています（合計 44 ケース: 落とす 20 / 通す 16 / 承認トークン 8）。

```bash
node kit/scripts/test-guard-sql.mjs    # pass: 44   fail: 0
```

同じ形のフックがもう 1 つあります。`guard-secrets` は、`.env` や秘密鍵を
**シェル経由で読むのを止めます**。`deny` の `Read(./.env)` は Read ツールにしか
効かないので、`cat .env` も `Get-Content .env` も素通りしていました。
落とすのは「秘密ファイルのパス」と「読み出しの形」が両方あるときだけです
（合計 51 ケース: 落とす 26 / 通す 25）。

```bash
node kit/scripts/test-guard-secrets.mjs   # pass: 51   fail: 0
```

フックは 2 種類あって、挙動は同じです。

| | 動く場所 | 備考 |
|---|---|---|
| `guard-sql.mjs` | Windows / macOS / Linux | 既定。Claude Code が Node で動くので、追加インストールは不要 |
| `guard-sql.ps1` | Windows | Node をフックの経路に入れたくない場合 |

CI では Node 版を Ubuntu / macOS / Windows、PowerShell 版を Windows / Ubuntu で回しています。

→ [docs/02-guardrails.md](docs/02-guardrails.md) / [kit/claude/hooks/guard-sql.mjs](kit/claude/hooks/guard-sql.mjs)

### 3. 役割分担

同じ「Claude」でも、置き場所で得意が違います。

| どこ | やること | やらせないこと |
|---|---|---|
| チャット（Cowork / claude.ai） | 設計・判断・調査・仕様を固める | ローカルの git 操作、ネイティブビルド |
| Claude Code（手元） | ファイル操作・git・ビルド・テスト | 仕様を勝手に決めること |
| GitHub MCP | PR 作成・レビュー・マージ | — |

→ [docs/03-division-of-labor.md](docs/03-division-of-labor.md)

### 4. 複数案件を 1 人でまわす

朝 PC を開いた時点で全リポジトリが最新。作業ブランチにいるときは `main` だけ進めて、
汚れている作業ツリーには一切触らない（`stash` も `reset` も `checkout` もしない）。

それを、本物の git リポジトリ 6 状態（clean / dirty / 作業ブランチ / detached HEAD /
**実際に競合させた rebase の途中** / diverged）を作ってテストしています。
確認しているのは主に「触ってはいけないものに触らなかった」side です。

```bash
node kit/scripts/test-pull-all.mjs     # pass: 44   fail: 0
```

**Windows PowerShell 5.1 でも確認済みです。** 5.1 は 7.x とは別物で、実際にそこでしか
出ない不具合が 1 件見つかりました（[02](docs/02-guardrails.md) の PowerShell の落とし穴）。
いまは CI に `shell: powershell`（＝5.1）のジョブを別に回しています。

→ [kit/scripts/pull-all.mjs](kit/scripts/pull-all.mjs) / [docs/04-multi-project.md](docs/04-multi-project.md)

---

## 5 分で入れる

**Windows (PowerShell)**

```powershell
git clone https://github.com/ponponpon888/ai-workforce.git
cd ai-workforce
.\kit\scripts\install.ps1 -WhatIf   # 何が置かれるか確認
.\kit\scripts\install.ps1           # 実行（既存ファイルは .bak に退避）
```

**macOS / Linux**

```bash
git clone https://github.com/ponponpon888/ai-workforce.git
cd ai-workforce
node kit/scripts/install.mjs --dry-run
node kit/scripts/install.mjs
```

インストーラがやること:

1. `~/.claude/CLAUDE.md` と `~/.claude/settings.json` を配置（既存は `.bak` にバックアップ）
2. `~/.claude/hooks/` に guard-sql を配置し、`settings.json` の `PreToolUse` に登録
3. 残りの手作業（動作確認と `pull-all` の登録）を表示する

**消しません。** 上書きするものは必ず `.bak.<日時>` に退避します。

---

## 設定と導入状態を診断する

```powershell
node kit/scripts/doctor.mjs --template  # 配布設定の静的チェック
node kit/scripts/doctor.mjs             # ~/.claude の登録とファイルを確認
```

設定や登録されたコマンドは変更・実行しません。結果は `static-pass` / `error` /
`incomplete` に分かれます。**静的チェックの成功は、Claude Code本体での動作確認を意味しません。**
判定範囲と終了コードは [診断の説明](docs/09-settings-doctor.md) に記載しています。

---

## ドキュメント

| | |
|---|---|
| [00 原則](docs/00-principles.md) | なぜこの形になったか。8:2 の内訳（[EN](docs/00-principles.en.md)） |
| [01 2 層の CLAUDE.md](docs/01-two-layer-claude-md.md) | 共通ルールと案件ルールの分け方 |
| [02 機械的な歯止め](docs/02-guardrails.md) | フック・deny リスト・承認モードの設計（[EN](docs/02-guardrails.en.md)） |
| [03 役割分担](docs/03-division-of-labor.md) | チャット / Claude Code / MCP の使い分け |
| [04 複数案件運用](docs/04-multi-project.md) | 自動 pull、絶対パス指定、命名規約 |
| [05 本番 DB の取り決め](docs/05-production-db.md) | Supabase を AI に触らせるときの線引き |
| [06 チャット側の穴を塞ぐ](docs/06-supabase-mcp.md) | Supabase MCP の `read_only` / `project_ref`、プロンプトインジェクション |
| [07 GitHub と Vercel の穴](docs/07-github-vercel.md) | MCP の読み取り専用・ツール除外、PAT では force-push を止められない話 |
| [08 落とし穴のデータ化](docs/08-pitfall-records.md) | 実測・推論・公式・未検証を混ぜずに記録する。`data/pitfalls/` |
| [事例](docs/case-studies/) | 実プロダクトからの引用 |
| [99 FAQ](docs/99-faq.md) | よくある質問 |

---

## 実プロダクトからの引用

このリポジトリの内容は、以下の稼働中サービスの開発でそのまま使っているものです。
各事例に、実際のコード断片と「そこで何が起きたか」を載せています。

| プロダクト | 内容 | 事例 |
|---|---|---|
| Hanami Nail | 訪日客と東京のネイルサロンをつなぐプラットフォーム | [事例](docs/case-studies/hanami-nail.md) |
| 美容領域のマッチングプラットフォーム | 契約上の理由により名称を伏せています | [事例](docs/case-studies/beauty-matching.md) |
| MUSUBU | LINE × AI の予約 SaaS | [事例](docs/case-studies/musubu.md) |

---

## 作った人

**公門 慎吾 (Shingo Kumon)** — くもん しんご

- 13 年、ホテル・旅館の支配人
- 非エンジニア。プロダクトはすべて AI と 2 人で作っています
- [shingokumon.com](https://www.shingokumon.com) / Threads [@shingokumon](https://www.threads.net/@shingokumon)

開発の相談は上記サイトから。国内・海外どちらでも。

---

## 貢献

歓迎します。特に **あなたが踏んだ落とし穴**。コードは要りません、Issue に 3 行で構いません。
このリポジトリの中身は、ほぼ全部そうやって足されたものです。

書いてあることが間違っている、という指摘も同じくらいありがたいです。

→ [CONTRIBUTING.md](CONTRIBUTING.md)

## ライセンス

MIT. 商用利用・改変・再配布すべて自由です。クレジットも不要です。
役に立ったら Star か、どう使ったかを教えてもらえると嬉しいです。

