# 変更履歴

日本語が正本です。各項目は「何が入ったか」と、必要なら「なぜ」を書きます。
実測の結果は [`data/pitfalls/`](data/pitfalls/) のレコードと [`measurements/`](measurements/)、
判断の履歴は [ROADMAP.md](ROADMAP.md) にあります。

バージョンは [Semantic Versioning](https://semver.org/lang/ja/) に従います。
`0.x` のあいだは、設定テンプレートの形やフックの既定の厳しさが変わることがあります。

---

## 未リリース

- **[hook-010](data/pitfalls/hook-010.json) を塞いだ**（status: closed）。`guard-sql` が、シェル経由の
  コマンドについて DDL キーワードを**コマンド行の生テキスト**に照合していたため、SQL クライアントの
  名前とキーワードが「実行される SQL としてではなく単なるテキスト」として同じ行に出てくるだけで
  ブロックしていた。着手前の実測で**代表10ケース中5件が誤検知**（すべて安全側。本物の危険4件は
  すべて阻止）。
  共有レクサーでコマンド行を字句解析し、**クライアントに実際に渡っている引数だけ**を取り出して
  検査する形にした（`psql -c` / `mysql -e` / `supabase db execute --sql` / `sqlite3` の位置引数など）。
  クライアントでないコマンドは何も寄与しないので、`git commit -m "...psql -c 'DROP TABLE x'..."`
  からは検査対象が1つも出てこない。`npx` などのラッパーは剥がす。
  **コマンド行そのものは一切書き換えていない。** hook-010 の `why_not_closed` が警告していた
  「賢くしたせいで空く」失敗（`--sql` ごと消えて `TRUNCATE` が視界から外れる）は、無害化をやめて
  「引数を取り出すだけ」にしたことで構造的に起こらない。無害化は取り出した SQL に対して当てる。
  レクサーが読めなかった行は従来どおり生テキストで走査する（答えが減るのは許容、ブロックが減るのは不可）。
  テストは Node 87 → 91、PowerShell 87 → 90。「テキストとして書かれただけの DDL は通す」側と
  「同じ形で実際に実行されるものは止める」側を**対にして**足した。修正前の実装では、増やした
  allow 側が落ちることを確認済み。`docs/02`（日英とも）の「既知の誤検知」節も書き換えた。
- 実装中に PowerShell 特有の罠を2つ踏んだので記録しておく。どちらも CI ではなく手元で捕まえた。
  1つ目は**型制約付きパラメータと同名のループ変数**。`Get-ClientCall` の引数が `[string] $Command`
  のとき、PowerShell は変数名の大小文字を区別しないので `foreach ($command in ...)` は同じ変数への
  代入になり、hashtable が文字列 `"System.Collections.Hashtable"` に変換されていた。
  2つ目は**配列保護の二重適用**。`Get-GdAfterOptions` は `return , (...)` で配列を保護して返すので、
  呼び出し側で `@()` を重ねると「要素が配列1個」になる。どちらもコメントに残した。

- `kit/scripts/check-doc-links.mjs` を追加。README と `docs/` の Markdown の**相対リンクが
  実在するファイルを指しているか**を検査する（249本）。`#見出し` が付いていて指す先が
  リポジトリ内の Markdown なら、見出しの実在も見る。入れた理由は、実際にリンク切れが2本
  出荷されたから: `docs/02-guardrails.en.md` が `](data/pitfalls/hook-010.json)` と書いていて、
  日本語の正本にある `../` が落ちていた（#40 の合流時に手作業で見つけて直した）。リンクを
  見る仕組みが無かったので誰も気づかず、英訳を増やすたびに同じ機会が増える状態だった。
  見出しの照合は落とし穴レコードの `origin` と同じ実装を使う。共通部分を
  `kit/scripts/markdown-anchors.mjs` に切り出し、`validate-pitfalls` はそこから読むように
  した（挙動は変えていない。`test-validate-pitfalls` で確認）。2つ持つと、見出しに記号が
  入った瞬間に食い違うため。`http(s)` と `mailto` は見ない（ネットワークに出ると、変更と
  関係のない理由で落ちるようになる）。フェンスとインラインコードの中も見ない（コード例で
  あって、リンクではない。この方針は自分の解説ページの例を誤検出して気づいた）。
  テストは `test-check-doc-links.mjs` 30件。**出荷された実物のリンク切れ2本を、この
  チェッカーが検出することを確認済み**。
- 上を入れるときに、**文書だけの変更では CI が1つも走っていなかった**ことが分かった。
  `test.yml` は無料枠対策（[ci-001](data/pitfalls/ci-001.json)。macOS の単価は Linux の
  約10倍）で `**/*.md` と `docs/**` を `paths-ignore` にしているため、リンクを壊す種類の
  変更が、ちょうど検査を素通りしていた（#40 も CI 0件で入っている）。文書の検査だけを
  `.github/workflows/docs.yml` に分けた。Ubuntu 1ジョブ、数秒。`check-doc-todos` も同じ
  理由でこちらに入れた（こちらも文書だけの PR では走っていなかった）。無料枠対策は
  そのまま維持している。

- `guard-destructive` が持っていた**シェルのレクサーを `kit/claude/hooks/lib/shell-lex.mjs` に
  切り出した**。中身は一行も変えていない（680行がそのまま。足したのは `export` と冒頭の説明だけで、
  抽出後に元の範囲と行単位で一致することを確認している）。`guard-destructive` のテスト219件は
  すべて成功し、挙動が変わっていないことの担保になっている。
  切り出した理由は [hook-010](data/pitfalls/hook-010.json) で、`guard-sql` が同じものを必要とする
  ため。シェルの引用規則をもう1つ書くのは、この種の中で最も確実に食い違う書き方になる。
  公開している名前は `Word` / `lexPosix` / `lexPs` / `lexCmd` / `newCommand` の5つだけで、
  レクサー側から解析側への参照は0本だった（境界がもともと綺麗だった）。
  **危険と分かったことも書いておく。** 単体ファイルだったフックに、初めて実行時の依存が増えた。
  依存が見つからないと import が失敗し、フックは入力を読む前に**exit 1**で終わる。Claude Code は
  2以外の終了コードを「報告するが従わない」扱いにするので、**登録されたまま、ファイルも在るのに、
  何も止めないフック**になる — このキットが避けようとしている形そのもの。実際、既存の
  「リンク経由で起動しても止まること」のテスト（hook-008 の回帰テスト）が、フックだけコピーして
  lib を置いていかなかったために落ちて教えてくれた。3層で塞いだ:
  インストーラが `lib/` も置く、`doctor` が依存の不在を名指しする（新しい検査 `*.dependency`）、
  `probe-guards` が実行時に落とす（`guard-destructive` が `expected block (exit 2), it exited 1`
  で fail になることを実測し、テストに固定した）。`guard-config` の保護対象は `hooks` の前方一致
  なので `hooks/lib/` も既に守られている（Edit も rm も exit 2 になることを確認）。
  PowerShell 版も同じ形で切り出した（`lib/shell-lex.ps1`、797行が行単位で一致。PowerShell は
  export が要らないので足したのはヘッダだけ）。読み込みは `$PSScriptRoot` からの dot-source。
  `guard-destructive` の PowerShell 側テスト218件も成功。依存が欠けたときの壊れ方は Node と
  同じで、dot-source が投げてフックは入力を読む前に exit 1 になる（実際に lexer を消して確認）。
  `install.ps1` が入れた種類（node / powershell）に応じて `lib/` を置き、`doctor` の依存表にも
  `guard-destructive.ps1` を足した。


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
  テストは Node 版 45 → 53 件、PowerShell 版 45 → 52 件で、修正前の実装では増やした分の
  うち4件が落ちることも確認した。`probe-guards` の不一致判定も新しい挙動に合わせ、
  `AIWF_CLAUDE_HOME` が別の場所を指しているときだけ警告して incomplete にする（12件）。
- 上の修正を macOS の CI が落として、**もう1段の穴**が出た。これは新種ではなく
  [hook-008](data/pitfalls/hook-008.json) と同じ class の再発で、あちらは
  `guard-destructive` で一度閉じている（「直接起動されたときだけ動く」判定が、
  シンボリックリンク経由だと成立せず、フックが何も見ずに exit 0 した）。あのときも
  落ちたのは macOS のジョブだけだった。**1つのフックを直しただけで、class に対する
  回帰テストを足していなかった**ので、同じ仕組みが guard-config では「保護対象の home を
  どう決めるか」という別の形で戻ってきた。下の CI ステップは、本来 hook-008 を閉じた
  ときに足すべきものだった。
  Node の ESM ローダーは
  `import.meta.url` のシンボリックリンクを解決するので、自分の位置から導出した home は常に
  正規化後の綴りになる。macOS の `tmpdir()` は `/var/...`（`/private/var/...` へのリンク）
  なので、**`settings.json` に登録されている綴り＝エージェントが実際に渡してくる綴りが、
  保護対象と一致しない**。起動されたパス（`process.argv[1]`）からも home を導出し、両方の
  綴りを守るようにした。シンボリックリンク経由で登録した home で再現するテストを足し、
  修正前の実装で落ちることも確認した（プラットフォームに依存しない形なので Linux でも回る）。
- 再現手段が無いまま CI に投げて2往復したので、**Linux で両方を再現できる形**にして CI に
  入れた。`TMPDIR` をシンボリックリンク経由のディレクトリに向けるだけで、macOS の
  `/var` → `/private/var` と同じ条件になる。修正前のフックをこの条件で回すと、
  `test-guard-config` が macOS の CI と同じ3件、`test-probe-guards` が Windows の CI と
  同じ 6 pass / 6 fail で落ちる。Ubuntu ジョブに1ステップ足したので、次に同じ壊れ方を
  したときは数十秒で分かる（macOS / Windows ジョブの完走を待たずに済む）。ステップ自体が
  「TMPDIR が本当にリンク経由になっているか」を先に確かめてから走る（条件が崩れた状態で
  緑になるのは、テストが無いのと同じなので）。
- **PowerShell 版にも同じ不具合があった。** 最初はそう書いていなかった（「`$PSCommandPath` は
  リンクを解決しないので元から無い」）が、それは Linux の pwsh 7.4.6 で測っただけの話を
  Windows へ一般化した誤りで、Windows の CI が落として分かった。**Windows の PowerShell は
  8.3 短縮名（`C:\Users\RUNNER~1\...`）を長い形へ展開する**ので、`$PSCommandPath` から
  導出した home は登録された綴りと食い違う。Node の `import.meta.url` と同じ壊れ方が、
  別の仕組みで起きていた。`[Environment]::GetCommandLineArgs()` は `-File` に渡された生の
  引数を返す（`process.argv[1]` 相当）ので、そこからも導出して両方の綴りを守るようにした。
  テストは、起動パスに `/./` の迂回を入れる形にした。PowerShell は `$PSCommandPath` から
  これを落とし、生の引数には残すので、**8.3 と同じ食い違いがどのプラットフォームでも作れる**。
  修正前の実装ではこのケースが落ちることを確認済み（PowerShell 版 52 → 55 件）。
  `test-guard-config.ps1` は Ubuntu でも回しているので、次は最安のジョブで捕まる。
- 残る差は1点だけ: Linux / macOS の pwsh では、**シンボリックリンクを解決した先の綴り**を
  PowerShell 版が保護しない（Node 版は保護する）。祖先のリンクまで解決するには
  `ResolveLinkTarget`（.NET 6+）が要り、CI が回している Windows PowerShell 5.1 には無い。
  [hook-014](data/pitfalls/hook-014.json) に、両ランタイムの綴りの食い違いとしてまとめ直した
  （status: closed。残差は `fix` の中に明記）。

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
