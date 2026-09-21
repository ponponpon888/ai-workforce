# AI Workforce

**非エンジニアが 1 人で、本番稼働するプロダクトを複数本まわすための運用一式。**

コードを書くのは AI。人間がやるのは、判断と、AI が事故らないための機械的な歯止めを敷くこと。
このリポジトリは、その「歯止め」と「段取り」を、動く形で公開しています。

## 実際に踏んだこと

- **無効な設定を1つ書くと、`settings.json` が丸ごと無視される。** `disableAutoMode: true`
  のような無効値があると、Claude Code は黙って無視するのではなく、`allow` / `deny` / `ask`
  を含む設定ファイル全体をスキップする。ガードレールを書いたつもりで、何も守っていない
  状態になり得る。（[実測](measurements/2026-09-10-modes-and-paths.md)）
- **`Read` だけの deny と `Edit` だけの deny は、対称ではない。** `Read(./secrets/**)` は
  Edit・Write の両方も止めるが、`Edit(...)` だけを deny しても Read は素通りする。
  どちらか片方しか書いていないと、思っているより弱い。
- Windows PowerShell 5.1 でしか再現しない不具合が複数見つかっている（7.x では起きない）。
  日本語圏の実測記事でもここまでは書かれていない。

> **正直な断り書き。** 中身は、本番を守っている構成を**公開用に書き起こしたもの**です。
> 手元で動いている実物そのものではありません。
> Windows PowerShell 5.1 / 7、Linux、macOS の Node、GitHub Actions（Ubuntu/Windows/macOS）
> で実機確認済み。検証数・対象は [統合状況](docs/17-integration-status.md) を参照。

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
- 方言固有の取り消せない文（MySQL の `RENAME TABLE` / `REPLACE` / `LOAD DATA` / `FLUSH` / `RESET` / `PURGE ... LOGS` / `OPTIMIZE` / `REPAIR` / `SET PASSWORD`、SQLite の `ATTACH` / `DETACH` / 状態を変える `PRAGMA` / `INSERT OR REPLACE`）

読み方はクライアントごとに変えています。`-f` は psql では `--file`、mysql では `--force` で、
psql の読み方を当てていたときは `mysql -f app -e "select 1"` という**ただの SELECT を落として**
いました（[hook-012](data/pitfalls/hook-012.json)）。`#` も、MySQL では行コメント、Postgres では
演算子です。`delete from t # where id = 1` は MySQL ではテーブルが空になります。

DDL は「人間が承認したその文が、15 分だけ、1 回だけ通る」。
文が 1 文字違えば通りません。

誤検知しないことの方が大事なので、テストは「止まるべきもの」と
「止まってはいけないもの」を両方見ています（合計 87 ケース: 落とす 42（うち MySQL 12 / SQLite 10） /
既知の制約として残した誤検知 2（[hook-010](data/pitfalls/hook-010.json)） / 通す 32 / 承認トークン関連 11）。

```bash
node kit/scripts/test-guard-sql.mjs    # pass: 87   fail: 0
```

同じ形のフックが、あと 3 つあります。**4 つとも、止める理由も、テストの形も同じです。**

| フック | 何を止めるか | テスト |
|---|---|---|
| `guard-sql` | `DROP` / `TRUNCATE` / `WHERE` のない `UPDATE`・`DELETE`、承認のない DDL。Postgres / MySQL / SQLite を読み分け、方言固有の取り消せない文（`RENAME TABLE`・`REPLACE`・`ATTACH`・状態を変える `PRAGMA` など）も承認対象にする | 87 |
| `guard-secrets` | `.env` や秘密鍵を**シェル経由で**読むこと。`deny` の `Read(./.env)` は Read ツールにしか効かず、`cat .env` も `Get-Content .env` も素通りしていた | 65 |
| `guard-config` | エージェントが**自分のガードレールを書き換える**こと。`settings.json`・`CLAUDE.md`・`hooks/`・DDL の承認ファイル置き場が対象。`settings.json` は起動していない間の書き換えも `SessionStart` で検知（警告のみ） | 45 |
| `guard-destructive` | `deny` に書いてある破壊系コマンドが、**`deny` の一致しない書き方**で来たとき。`bash -c 'rm -rf x'`、`/bin/rm`、`sudo`、`npx rimraf`、`git -C . push --force`、`rm -rfv`、`cmd /c rd /s`、`node -e` の `rmSync` など。あわせて、`deny` には無いが同じく取り消せない `find -delete`、`git stash drop` / `clear`、`gh repo sync --force`、`gh repo delete` | 219 |

`guard-config` が `approvals/` まで見るのは、DDL の承認ファイルを**エージェント自身が書けてしまった**からです。
ハッシュの計算式はこのリポジトリに公開されているので、書ければ人間に見せずに自分で承認できました
（[hook-006](data/pitfalls/hook-006.json)）。

`guard-destructive` が要る理由は、`deny` の限界がはっきりしているからです。公式ドキュメントは、
`deny` が「プログラムのまわりのセキュリティ境界ではない」と明記しています。`cd /tmp && rm -rf x` や
`timeout 30 rm -rf x` は Claude Code 自身が止めますが、`bash -c` や `/bin/rm` や `git -C` は止めません
（[perm-006](data/pitfalls/perm-006.json)）。

```bash
node kit/scripts/test-guard-sql.mjs           # pass: 87    fail: 0
node kit/scripts/test-guard-secrets.mjs       # pass: 65    fail: 0
node kit/scripts/test-guard-config.mjs        # pass: 45    fail: 0
node kit/scripts/test-guard-destructive.mjs   # pass: 219   fail: 0
```

どのフックにも PowerShell 版があり、挙動は同じです。

| | 動く場所 | 備考 |
|---|---|---|
| `*.mjs` | Windows / macOS / Linux | 既定。Claude Code が Node で動くので、追加インストールは不要 |
| `*.ps1` | Windows | Node をフックの経路に入れたくない場合。`install.ps1 -Hook powershell` |

PowerShell 版は同じテストを `--target ps` で当てて確かめています。CI では Node 版を
Ubuntu / macOS / Windows、PowerShell 版を Windows / Ubuntu と、Windows PowerShell 5.1 でも回しています。

→ [docs/02-guardrails.md](docs/02-guardrails.md) / [kit/claude/hooks/](kit/claude/hooks/)

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
node kit/scripts/test-pull-all.mjs                 # Node 版        pass: 73   fail: 0
node kit/scripts/test-pull-all.mjs --target ps     # PowerShell 版  pass: 61   fail: 0
node kit/scripts/test-pull-all.mjs --target sh     # POSIX シェル版 pass: 73   fail: 0
```

実装は3つあります（Node / PowerShell / POSIX シェル）。**同じフィクスチャを3つに当てているので、
挙動がずれません。** 実際、3つ目を足したときに PowerShell 版だけが `.dotfiles` のような
ドット始まりのフォルダを飛ばしていたことが分かりました（[shell-003](data/pitfalls/shell-003.json)）。

**Windows PowerShell 5.1 でも確認済みです。** 5.1 は 7.x とは別物で、実際にそこでしか
出ない不具合が 1 件見つかりました（[02](docs/02-guardrails.md) の PowerShell の落とし穴）。
いまは CI に `shell: powershell`（＝5.1）のジョブを別に回しています。

→ [kit/scripts/pull-all.mjs](kit/scripts/pull-all.mjs) / [pull-all.sh](kit/scripts/pull-all.sh) / [docs/04-multi-project.md](docs/04-multi-project.md)

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
2. `~/.claude/hooks/` に 4 つのフックと DDL の承認スクリプト・設定基準の再記録スクリプトを配置し、
   `settings.json` の `PreToolUse`・`ConfigChange`・`SessionStart` に登録
3. 今の `settings.json` を `~/.claude/known-good/settings.json` に基準として記録する
4. 残りの手作業（動作確認と `pull-all` の登録）を表示する

**消しません。** 上書きするものは必ず `.bak.<日時>` に退避します。

**入れたら、Claude Code を `/exit` で終了して起動し直してください。** 起動中のセッションは、
起動したときの設定のまま動きます（guard-config は、起動中のセッションへの設定変更を意図的に拒否します）。
起動し直したら `/hooks` を開いて、`PreToolUse` の `Bash|PowerShell` が **2 hooks**、
`SessionStart` が **1 hook** になっているかを確認してから試してください。`PreToolUse` が 1 件のままなら、
入れ替え前の設定で試していることになります（[hook-009](data/pitfalls/hook-009.json)）。

---

## 設定と導入状態を診断する

```powershell
node kit/scripts/doctor.mjs --template  # 配布設定の静的チェック
node kit/scripts/doctor.mjs             # ~/.claude の登録とファイルを確認
node kit/scripts/probe-guards.mjs       # 登録されたフックに実際に入力を渡して、止まるか確かめる
```

`doctor` は設定や登録されたコマンドを変更・実行しません。結果は `static-pass` / `error` /
`incomplete` に分かれます。**静的チェックの成功は、Claude Code本体での動作確認を意味しません。**

**`probe-guards` は逆で、登録されているコマンドをそのままの綴りで起動します。** 止めるべき入力
（`drop table`、`cat .env`、`bash -c 'rm -rf …'`）と通すべき入力（`select 1`、`npm run build`）を渡して、
終了コードを見ます。パスの間違い、コピーし損ねたフック、Node版とPowerShell版の取り違え、
編集して壊れたフック — 静的検査では `static-pass` に見えるものが、ここで落ちます。
**ペイロードの中のコマンドは実行しません**（読むだけのフックに渡す文字列です）。DBにも繋がず、
ファイルも書きません。

最初に流したときに1つ見つかりました。**`guard-config` が守るのは「インストールされた場所」では
なく `~/.claude` です。** 標準以外の場所へ入れると、フックは置かれて登録もされるのに、実際に
使われている設定は無防備でした（[hook-013](data/pitfalls/hook-013.json)）。`probe-guards` は
この食い違いを見つけたら警告して `incomplete` にします。

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
| [CHANGELOG](CHANGELOG.md) | 各版に何が入っているか。現在は v0.1.0 |
| [ROADMAP](ROADMAP.md) | 何を判断して、何を残したか |

---

## 実プロダクトからの引用

このリポジトリの内容は、以下の稼働中サービスの開発でそのまま使っているものです。
各事例に、実際のコード断片と「そこで何が起きたか」を載せています。

| プロダクト | 内容 | 事例 |
|---|---|---|
| Hanami Nail | 訪日客と東京のネイルサロンをつなぐプラットフォーム | [事例](docs/case-studies/hanami-nail.md) |
| 美容領域のマッチングプラットフォーム | 契約上の理由により名称を伏せています | [事例](docs/case-studies/beauty-matching.md) |
| MUSUBU | LINE × AI の予約 SaaS | [事例](docs/case-studies/musubu.md) |

## 導入支援・相談

このリポジトリは MIT ライセンスで、ダウンロードして自分で導入できます。使い方の質問、再現可能な不具合、実際に踏んだ落とし穴は [Issues](https://github.com/ponponpon888/ai-workforce/issues) へどうぞ。公開Issueには、秘密情報・社内データ・顧客情報を貼らないでください。

自社の環境に合わせた導入が必要な場合は、個別に支援できます。

- 現在のClaude Code設定と運用フローの診断
- 本番DB・秘密情報・Git操作に対するガードレール設計
- 独自フック、診断ツール、承認フローの実装
- 少人数チームへの導入設計と運用ルール整備
- 小さな業務デモから始めるAI活用の検証

事例にある Next.js + Supabase + Vercel のプロダクトそのものの開発も請けています。
規模別の目安です（要件により前後します）。

| 規模 | 目安 |
|---|---|
| ガードレール・運用のレビュー（既存環境の診断と改善案の提出） | 30〜60万円 |
| 動くプロダクト（認証・DB・管理画面・メール送信まで含めて公開） | 60〜150万円 |
| 多面プラットフォーム、外部連携、継続的な開発 | 150万円〜 |
| 保守 | 月3万円〜 |

相談時点で発注を決める必要はありません。現在の運用と困っていることを確認し、OSSの範囲で解決できるか、個別実装が必要かを切り分けます。

**[AI Workforceの導入について相談する](https://www.shingokumon.com/contact)**

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
