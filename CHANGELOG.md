# 変更履歴

日本語が正本です。各項目は「何が入ったか」と、必要なら「なぜ」を書きます。
実測の結果は [`data/pitfalls/`](data/pitfalls/) のレコードと [`measurements/`](measurements/)、
判断の履歴は [ROADMAP.md](ROADMAP.md) にあります。

バージョンは [Semantic Versioning](https://semver.org/lang/ja/) に従います。
`0.x` のあいだは、設定テンプレートの形やフックの既定の厳しさが変わることがあります。

---

## 未リリース

- `guard-sql` が SQL の方言（Postgres / MySQL / SQLite）を読み分けるようになった。着手前に修正前の
  フックで実測したところ、MySQL の `RENAME TABLE` / `REPLACE INTO` / `LOAD DATA` / `FLUSH` /
  `RESET` / `PURGE BINARY LOGS` / `OPTIMIZE` / `SET PASSWORD`、SQLite の `ATTACH DATABASE` /
  `PRAGMA writable_schema=on` / `INSERT OR REPLACE` がいずれも素通りし、MySQL の `#` 行コメントで
  `WHERE` を隠した `delete from t # where id = 1`（MySQL では全行削除）も通っていた。さらに
  **正しい SQL を落とす誤検知**が1件あり、`mysql -f app -e "select 1"` が
  「SQL file is unreadable」で落ちていた（`-f` は psql では `--file`、mysql では `--force`。
  [hook-012](data/pitfalls/hook-012.json)）。ファイル経路・承認が要る文・include・無害化の4つを
  クライアントごとに分け、判別できないクライアント（`prisma db` / `drizzle-kit` など）は
  全方言の規則を当てて無害化しない扱いにした。`#` はコマンド行を無害化しない方針を変えずに、
  「`#` から行末を外した読み方でもう一度 `WHERE` の有無を見る」検査を足して塞いだ（ブロックを
  足す方向にしかならないので、`#` の後ろに隠せるようにはならない）。MCP のツール名も
  `mysql` / `mariadb` / `sqlite` を含むものが検査対象に入った。テストは 47 → 87 件
  （止める 42 / 既知の制約 2 / 通す 32 / 承認トークン 11）で、増えた 40 件のうち 16 件は
  「止まってはいけない」側。判断と理由は [ROADMAP.md](ROADMAP.md) と
  [`docs/02`](docs/02-guardrails.md)（英語版にも同じ節）に記録。
  **検証状況**: 手元（Linux / Node v22.22.2）で Node 版 87/87、PowerShell 7.4.6 で PowerShell 版
  87/87、`--target ps` の sql-boundaries（33）・pull-all（60）・guard-secrets（65）も成功。
  CI（[PR #38](https://github.com/ponponpon888/ai-workforce/pull/38)）は Ubuntu / Windows /
  macOS の3ジョブとも成功し、Windows ジョブの `shell: powershell`（**Windows PowerShell 5.1**、
  実際の出力は `5.1.26100.6584`）でも `test-guard-sql.ps1` が 87/87。Claude Code 本体に
  接続しての実地確認は未実施。
- `pull-all` の **POSIX シェル版**（`kit/scripts/pull-all.sh`）を追加。Node 版と同じオプション・
  同じログ行・同じ終了コードで、`/bin/sh` と `git` / `find` / `sed` / `tr` だけで動く。ログイン経路に
  Node を置きたくない、あるいは Node が入っていない機械向け。テストは既存のフィクスチャを
  そのまま使い、`node kit/scripts/test-pull-all.mjs --target sh` で同じ 73 件を当てる
  （実装が3つに分かれても挙動がずれないようにするため。`--target` の許可値はスイートごとに
  指定する形にしたので、シェル版を持たないスイートは今までどおり node / ps のみ）。
  意図的な差は1点だけで、古いログの削除が `find -mtime` による日単位判定になる
  （Node 版はミリ秒比較。POSIX の範囲で「今から N 日前」を portable に計算できないため）。
- 移植の過程で **PowerShell 版だけがドット始まりのリポジトリフォルダを飛ばしていた**ことが
  分かったので直した（[shell-003](data/pitfalls/shell-003.json)）。`Get-ChildItem -Directory` は
  Unix のドット始まり・Windows の隠し属性を既定で返さず、Node の `readdirSync` と
  シェル版の `find` は返す。`-Force` を足して揃え、3実装すべてに当たるテストを追加した
  （pull-all のテスト件数: Node / sh 72 → 73、ps 60 → 61）。
- `kit/scripts/probe-guards.mjs` を追加。`settings.json` に登録されているガードを**そのままの綴りで
  起動し**、止めるべき入力と通すべき入力を渡して終了コードを確かめる。`doctor.mjs` は「設定に
  書かれたコマンドを実行しない」ことが help・docs/09・テストで保証された契約なので、実行する側は
  別スクリプトに分けた（`docs/09` が「無害な対照入力でフックが呼ばれることを確認してください」と
  人手に投げていた部分）。パスの間違い・コピーし損ねたフック・Node版とPowerShell版の取り違え・
  matcher の穴・編集して壊れたフックは、静的検査では static-pass に見えるがここで落ちる。
  通す側の検査が半分を占める（全部止めるフックは、何も止めないフックと同じくらい壊れているため）。
  ペイロードの中のコマンドは実行せず、DBにも繋がず、ファイルも書かない。SessionStart は
  known-good の基準を書き込む経路なので送らない。終了コードは 0 probe-pass / 1 error /
  2 incomplete。テストは `test-probe-guards.mjs`（10件、`--target ps` でも同じ10件）で、
  骨抜きにしたフック・全部止めるフック・消したフック・登録を外した状態・壊れたJSON・
  ホーム不一致を、それぞれ別の結果として報告することを固定している。`verify-installers` の
  `core` にも入れ、CI の Ubuntu / Windows / macOS（Windows PowerShell 5.1 を含む）で回す。
- 最初に流して1件見つけた（[hook-013](data/pitfalls/hook-013.json)）。
  **`guard-config` は自分がインストールされた場所ではなく `~/.claude`（または `AIWF_CLAUDE_HOME`）を
  守っていた。** `--claude-home` で標準以外の場所へ入れると、フックはその場所に置かれ登録もされるのに、
  実際に使われている `settings.json` は保護対象に入らない。`AIWF_CLAUDE_HOME` はテストからしか
  設定されておらず、文書にも載っていなかった。`probe-guards` は実行時にこれを検出して警告し、
  incomplete として報告する。ガード本体の修正は次の項目（別PRで入れた）。

- `guard-config` が、保護対象の claude home を**自分の位置から導出する**ようになった。
  インストールされたフックは `<claude home>/hooks/guard-config.*` に置かれるので、そこから
  1つ上が「Claude Code がいま読んでいる home」になる。従来は実行時に `AIWF_CLAUDE_HOME`
  （未設定なら `~/.claude`）だけで決めていたため、`--claude-home` で標準以外の場所へ入れると
  **フックは登録されているのに、実際に使われている `settings.json` が無防備**だった
  （[hook-013](data/pitfalls/hook-013.json) / status: closed）。`AIWF_CLAUDE_HOME`
  （PowerShell 版は `-ClaudeHome`）は明示的な上書きとして残し、指定時はその home だけを守る。
  指定が無いときは導出した home と `~/.claude` の両方を守る（守る範囲を広げるのは安全だが、
  黙って狭めるのは危険なため）。ブロック時のメッセージは一致した方の home を名指しする。
  テストは両版とも 45 → 50 件で、修正前の実装では増やした5件のうち3件が落ちることも確認した。
  `probe-guards` の不一致判定も新しい挙動に合わせ、`AIWF_CLAUDE_HOME` が別の場所を指している
  ときだけ警告して incomplete にする（12件）。

- `docs/01`（2 層の CLAUDE.md）・`docs/03`（役割分担）・`docs/05`（本番 DB の取り決め）・
  `docs/06`（チャット側の穴を塞ぐ）・`docs/07`（GitHub と Vercel の穴）の英訳を追加。これで
  **4 本柱のうち 1・2・3 と、チャット側の穴を塞ぐ話が一式、英語で読める**ようになった
  （`docs/04`・`08` は日本語のみ）。`docs/07` は「fine-grained PAT のスコープでは force-push も
  ブランチ削除も止められない（止めるのは ruleset）」という、このリポジトリで一番引用される
  発見を含むので、英語で読めない状態が一番もったいなかった。
  英語版どうしのリンクも英語版を指すように直した（`docs/03` の英語版から `docs/06` への
  リンクが日本語ページに落ちていた）。README / README.en のドキュメント表と
  CONTRIBUTING の翻訳状況も更新。日本語が正本であることは変えていない。

- `guard-config` に `SessionStart` イベント（`startup|resume`）を追加。ConfigChange は
  実行中セッションへの反映を止めるだけでディスク上の `settings.json` は書き換わったまま
  残り、Claude Code を起動していない間の書き換えは検知すらできなかった
  （[hook-007](data/pitfalls/hook-007.json)）。`SessionStart` は起動のたびに発火するが、
  公式ドキュメントの通り exit code も `decision`/`permissionDecision` も無視され起動を
  ブロックできないため、`known-good/settings.json` に基準を持たせて起動時に比較し、
  不一致なら `additionalContext`/`systemMessage` に **警告** を出す（起動は止めない）形にした。
  基準が無ければ初回起動時に静かに採用。再記録は新設の
  `kit/scripts/record-settings-baseline.mjs`/`.ps1`（`approve-ddl.mjs` と同じ信頼モデル、
  インストーラが `approve-ddl` と同じ場所に設置）を人が手で実行する。副産物として、
  ConfigChange が読んでいたペイロードのフィールド名の誤り（`source` → 正しくは
  `config_source`）も見つけて直した。判断と理由は [ROADMAP.md](ROADMAP.md) と
  [hook-011](data/pitfalls/hook-011.json)（`status: open_recorded` — プラットフォーム制約に
  より「警告」以上には塞げないため）に記録（[`docs/02`](docs/02-guardrails.md) にも節を追加）。
  `guard-config` のテスト件数は 29 → 45（PreToolUse/ConfigChange 30、SessionStart 15）。

- `guard-sql` のテストに、既知の制約として残すと決めた誤検知（シェル経由コマンドで、
  実行される SQL としてではなく文字列として書いてあるだけの DDL キーワードに反応する）を
  2 件追加。件数は 45 → 47。塞ぐか残すかの判断と理由は [ROADMAP.md](ROADMAP.md) と
  [hook-010](data/pitfalls/hook-010.json) に記録（[`docs/02`](docs/02-guardrails.md) にも節を追加）。

## v0.1.0 — 2026-09-18

最初の公開版です。差分ではなく、何が入っているかを書きます。

### フック（`PreToolUse`。Node 版と PowerShell 版があり、挙動は同じ）

| フック | 何を止めるか | テスト |
|---|---|---:|
| `guard-sql` | `DROP` / `TRUNCATE` / `WHERE` のない `UPDATE`・`DELETE`。DDL は人間が承認したその文だけが 15 分・1 回だけ通る（SHA-256 のハッシュ承認トークン）。`-f` で渡したファイルや標準入力の中身、文の境界も見る | 45 |
| `guard-secrets` | `.env` や秘密鍵を**シェル経由で**読むこと。`deny` の `Read(./.env)` は Read ツールにしか効かず、`cat .env` も `Get-Content .env` も素通りしていた。`.env.example` のような公開前提のファイルと、`secrets/` 配下のソースコードは通す | 65 |
| `guard-config` | エージェントが**自分のガードレールを書き換える**こと。`settings.json`・`CLAUDE.md`・`hooks/`・`scripts/`・DDL の承認ファイル置き場が対象。`settings.json` は `ConfigChange` でも拒否する | 29 |
| `guard-destructive` | `deny` に書いてある破壊系コマンドが、**`deny` の一致しない書き方**で来たとき。`bash -c` / `eval` / `cmd /c` / `powershell -Command` / `-EncodedCommand`、`/bin/rm` のようなパス指定、`sudo` / `env` / `xargs -n1` / `find -exec` / `npx` などの実行ツール、`git -C` などのグローバルオプション、`rm -rfv` のようなフラグ違い、`node -e` の `rmSync`。あわせて、`deny` には無いが同じく取り消せない `find -delete`・`git stash drop` / `clear`・`gh repo sync --force`・`gh repo delete` | 219 |

`guard-config` が承認ファイル置き場まで見るのは、ハッシュの計算式がこのリポジトリに公開されている以上、
エージェント自身が承認ファイルを書ければ人間に見せずに DDL を通せたためです（[`hook-006`](data/pitfalls/hook-006.json)）。

`guard-destructive` があるのは、`deny` の限界が公式ドキュメントに明記されているためです。
`cd /tmp && rm -rf x` や `timeout 30 rm -rf x` は Claude Code 自身が止めますが、
`bash -c` や `/bin/rm` や `git -C` は止めません（[`perm-006`](data/pitfalls/perm-006.json)）。
`find -delete` 以下の 4 つだけは `deny` に対応する行がありません。一度消えると取り戻せない点が
`deny` の破壊系コマンドと同じなので、同じフックで止めています。

### 設定と導入

- `kit/claude/settings.json`: `defaultMode` は `default`、`disableAutoMode` と
  `disableBypassPermissionsMode` は `"disable"`、`allow` / `ask` / `deny` と 4 フックの登録
- `kit/claude/CLAUDE.md`（日英）: 全案件共通の安全ルールだけを書く 1 層目
- `install.mjs` / `install.ps1`: 事前検査してから配置し、上書きするものは必ず `.bak.<日時>` に退避する。
  `--dry-run` / `-WhatIf` で何が起きるかだけ出せる。`-Hook node|powershell` で実装を選べる
- `doctor.mjs`: 読み取り専用の診断。設定も登録されたコマンドも実行しない
- `approve-ddl.mjs` / `.ps1`: 人間が SQL を読んでから自分で叩く承認スクリプト
- `pull-all.mjs` / `.ps1`: 全リポジトリを最新にする。作業ブランチにいるときは `main` だけ進め、
  汚れた作業ツリーには触らない（`stash` も `reset` も `checkout` もしない）
- `kit/supabase/agent-readonly-role.sql`: 直接接続の経路向けの読み取り専用ロール（検証手順つき）
- `kit/critical-gate/`: 重大な操作に証拠を要求する仕組みのプロトタイプ

### 記録と検査

- 落とし穴レコード 20 件（`data/pitfalls/`）と、その形式検証・静的検査・索引生成
  （`validate-pitfalls.mjs` / `lint-pitfalls.mjs` / `build-pitfall-index.mjs`）
- 文書内の未完了マーカー検査（`check-doc-todos.mjs`）
- 実測の手順と生の結果（`measurements/`）
- ドキュメント 00〜18 と事例 3 本。英訳は README / 00 / 02

### CI

Ubuntu / Windows / macOS で、Node 版と PowerShell 版（pwsh と Windows PowerShell 5.1）の
全スイート、両インストーラの使い捨て home への導入、`.ps1` のパースと非 ASCII 検査。
Markdown だけの変更では走りません。

### 実測で確定したこと（抜粋）

- **無効な値を 1 つ書くと `settings.json` が丸ごと無視される。** `allow` / `deny` / `ask` ごと
  スキップされるので、書いたつもりで何も守っていない状態になり得る
- **`deny` の記法（`Bash(x:*)` と `Bash(x *)`）は同じ挙動で、単語の途中では切れない。**
  `rm -rfv` は `Bash(rm -rf:*)` を抜ける（[`perm-001`](data/pitfalls/perm-001.json) /
  [`perm-005`](data/pitfalls/perm-005.json)）
- **`Read(...)` だけの deny は Edit も Write も止めるが、`Edit(...)` だけの deny は Read に漏れる**
- **`ConfigChange` のブロックは、実行中のセッションへの反映を止めるだけ。**
  ディスク上のファイルは書き換わったまま残り、起動していない間の変更は検知できない
  （[`hook-007`](data/pitfalls/hook-007.json)）
- **MCP のツール名の接頭辞はコネクタごとに変わる。** 固定接頭辞で matcher を書くと発火しない
  （[`hook-004`](data/pitfalls/hook-004.json)）

### 既知の制約

- フックはコマンドの文字列を読むだけです。スクリプトファイルの中身、`npm run` の中身、
  `ssh` や `docker exec` の先は見えません。文字列に依存しない強制が要るならサンドボックスです
- `permissions` の層にテストは書けません（判定しているのは Claude Code 本体）。
  書けるのは手順と測定結果だけです
- 設定を入れ替えたあと Claude Code を起動し直さないと、前の設定のまま動きます。
  入れたら `/hooks` で件数を確認してから試してください（[`hook-009`](data/pitfalls/hook-009.json)）
- 制約の一覧は [ROADMAP.md](ROADMAP.md) の「基本版の制約と判断」にあります
