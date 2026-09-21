# ロードマップ

基本機能の実装と Linux / Node での統合検証は完了しました。v0.1 の公開は実機確認と CI の成功待ちです。
現在の検証数・対象・取り込み元は [統合状況](docs/17-integration-status.md) を参照してください。
過去の Windows 実測は現在の統合版の検証結果ではありません。変更の履歴は Git と measurements に保持しています。

**2026-09-17、リポジトリをpublicにした。** GitHub Actionsの予算アラート（9月分 $7.51/$10）が
きっかけ。privateだと無料枠超過分が課金される（Windows 2倍・macOS 10倍）ため、
`ci/cut-actions-minutes`（docsのみのpush/PRをスキップ・macOSを`workflow_dispatch`専用に）を
先に入れたうえで公開した。公開前に、コミット履歴を含めた秘密情報の簡易チェック（サービスロール
キー・APIキー・秘密鍵等のパターン）を実施し、該当なしを確認済み。README / README.en の
テストケース数（44→45）も公開前に修正した。公開後、GitHub-hostedランナーが無料無制限になった
ため、`ci/restore-macos-on-public`（PR #25）でmacOSジョブをpush/PR両方に戻した
（docsのみpathsのスキップは課金と無関係の判断なので維持）。

## guard-config（自己改ざん防止）— 実装・マージ済み（PR #26〜#29）

**2026-09-17、外部の競合調査をきっかけに着手し、[PR #26](https://github.com/ponponpon888/ai-workforce/pull/26) でマージ済み。**
`karanb192/claude-code-hooks` が「エージェント自身にガードレールを書き換えさせない」専用
フック（config-guard）を持っていることを知り、AI Workforce にはこれが無いと気づいた。
さらにコードを読み返した結果、**guard-sql の DDL 承認ゲートには、人間を介さない自己承認
という具体的な抜け道があった**（[`hook-006`](https://github.com/ponponpon888/ai-workforce/blob/main/data/pitfalls/hook-006.json)、
confidence: inferred — 実際に自己承認を再現してはいない。approve-ddl のフィンガープリント
計算式が本リポジトリに公開されているため、エージェントが `~/.claude/approvals/` に直接
ファイルを書けば同じ値を計算して自己承認できてしまう）。

`kit/claude/hooks/guard-config.mjs` を新設。`settings.json`・`CLAUDE.md`・`hooks/`・
`scripts/`・`approvals/` のいずれかを、Edit/Write/MultiEdit/NotebookEdit ツールの
`file_path` で、または Bash/PowerShell のコマンド行（`&&`/`||`/`;`/`$(` で分割した
セグメントごと）で名指しする書き込み・削除・リネームを拒否する。`install.mjs` /
`install.ps1` / `kit/claude/settings.json` のテンプレートに配線済み。

**続けて、[PR #27](https://github.com/ponponpon888/ai-workforce/pull/27) で `ConfigChange` 層を追加・マージ済み。**
Claude Code公式の`ConfigChange`イベント（設定ファイルが変わったら`exit 2`で変更そのものを
拒否できる。matcherは`user_settings`等の設定ソース単位）にguard-config.mjsを追加登録し、
settings.jsonについてはPreToolUseが想定していない書き込み経路も含めて拒否できるようにした。
2026-09-17、Windows実機（Claude Code 2.1.274）で`--debug`ログを使って実際に発火することを
確認: セッション実行中に外部からsettings.jsonを直接書き換えると、フックが発火し
「ConfigChange hook blocked change to ...settings.json」と記録され、そのセッションには
反映されなかった。

**この過程で新しい仕様上の制約が判明した（[`hook-007`](https://github.com/ponponpon888/ai-workforce/blob/main/data/pitfalls/hook-007.json)、confidence: measured）**:
ConfigChangeのブロックは「今動いているセッションへの反映」を止めるだけで、**ディスク上の
ファイル自体は書き換わったまま残る**。さらに、**Claude Codeが起動していない間**に同じ
書き換えを行うと、次回起動時にはそれが「最初からの設定」として読み込まれ、ConfigChangeの
検知対象にすらならない（起動ログで確認済み）。guard-config.mjsのヘッダーコメントにこの
限界を明記した。

**続けて、[PR #28](https://github.com/ponponpon888/ai-workforce/pull/28) で `guard-config.ps1`（PowerShell版）を追加・マージ済み。**
guard-config.mjsと同じ保護対象・同じ2イベント（PreToolUse・ConfigChange）・同じセグメント
分割設計をPowerShellに移植。`install.ps1`の既存の`$Hook`スイッチ（node/powershell）に
guard-configも従うようにし、`test-guard-config.ps1`（29件）を追加。

**続けて、[PR #29](https://github.com/ponponpon888/ai-workforce/pull/29) で `doctor.mjs` の `guards` 配列にguard-configを追加・マージ済み。**
PreToolUse側は既存のguard-sql/secrets向けの認識・カバレッジ・ファイル存在チェックをそのまま
再利用。ConfigChange側は形が異なる（matcherがツール名でなく設定ソース）ため、独立した
別ブロックとして追加した（バグが混入しても既存のguard-sql/secretsチェックに影響しない設計）。
この変更で`test-doctor.mjs`の「インストール済みを模した」フィクスチャがConfigChange側の
プレースホルダを書き換えていなかったことが表面化し（想定通り）、該当4テストを修正。
副次的に、PowerShellインストーラ向けの2テストがguard-config.ps1を「まだ存在しない」前提の
古い特別扱いのままだったことも見つかり、PR #28で実際に存在するようになったことに合わせて
修正した。Windows実機で`test-doctor.mjs`（28/28）・`doctor.mjs --template`（static-pass）・
`test-guard-sql.mjs`/`.ps1`（45/45）・`test-guard-config.mjs`/`.ps1`（29/29）・
`test-install-backups.mjs`（Node/ps両方）・`test-installed-approval.mjs`（Node/ps両方）・
`test-verify-installers.mjs`（20/20）を確認してからマージした。

副次的に、`test-lint-pitfalls.mjs`の「チェック可能な件数」の決め打ちが`hook-004`追加時点
（5→6にすべきところ）から直っておらず古いままだったことも見つかり、`hook-006`/`hook-007`
分と合わせて正しい値（7・9）に直した（PR #27）。

guard-configはこれでNode版・PowerShell版・PreToolUse・ConfigChange・doctorによる静的検査、
すべて揃った。

## guard-destructive（deny をすり抜ける形の破壊系コマンド）— 実装・Windows 実機確認済み（PR #30）

**2026-09-17、「基本版以降」にあった「`permissions.deny` は前方一致なので `cd /tmp && rm -rf x` /
`timeout 30 rm -rf x` / サブシェル / パイプ経由ですり抜ける」という項目に着手し、前提が半分古かった
ことが分かった。** Anthropic の公式ドキュメント（[Configure permissions](https://code.claude.com/docs/en/permissions)、
同日参照）によると、Claude Code は `&&` `||` `;` `|` `&` と改行でコマンドを分けて deny を 1 つずつに当て
（サブシェル・`$(...)`・`for` の中も含む）、`timeout` `time` `nice` `nohup` `stdbuf` `command` `builtin`・
フラグなしの `xargs`・先頭の変数代入を外してから照合する。つまり上の 4 形はすでに deny で止まる。

一方、同じページは「deny はプログラムのまわりの境界ではない」として、一致しない形を明記している:
`/bin/rm -rf`、`bash -c 'rm -rf ...'`、`git -C . push`、`git -c k=v push`、`git 'push'`。フラグ付きの
`xargs`、`npx` / `devbox run` などの実行ツールも外されない。これに `perm-005` の `rm -rfv` と、
フラグを後ろに置いた `git push origin main --force` が加わる。
[`perm-006`](data/pitfalls/perm-006.json)（confidence: documented）として記録した。

`kit/claude/hooks/guard-destructive.mjs` を新設。deny に書いてある破壊系コマンド（再帰の `rm`・
`Remove-Item`・`rd /s`・`rimraf`・force push・`git reset --hard`・`git clean -f`・`git branch -D`・
`supabase db reset`）が、deny の一致しない形で来たときに止める。Bash は POSIX シェル、PowerShell は
PowerShell、`cmd /c` の中は cmd の文法で読み、`bash -c` / `eval` / `powershell -Command` /
`-EncodedCommand` / `Invoke-Expression` の中身、`sudo` / `env` / `xargs` / `find -exec` / `npx` などの先、
git のグローバルオプションの後ろまで追う。`test-guard-destructive.mjs` は 206 件（止める 135 / 通す 71）。
`$(cat <<'EOF' ...)` 形式のコミットメッセージに危ないコマンド名が書いてあるだけのケースを通すため、
`$( )` の対応取りでヒアドキュメント本文を読み飛ばすようにした。`perm-005` はこのフックで closed にした
（deny 側の穴は残る）。

settings.json テンプレート（4 つ目の PreToolUse）、`install.mjs`、`install.ps1`（`-Hook powershell` でも
Node 版を登録。`.ps1` 版はまだ無い）、`doctor.mjs` の `guards` 配列、`test-doctor` /
`test-install-backups` / `test-lint-pitfalls` を更新。docs/02（日英）に「deny をすり抜ける形の、
半分はもう古い話でした」の節を追加。

`.github/workflows/test.yml` にも `test-guard-destructive.mjs` の実行と、インストール先ファイルの確認を
足した（チャット側の GitHub 連携は workflow ファイルを書けないため、bundle で渡して手元から push した）。

**Windows 実機での確認で、テストが通っていたのにすり抜ける原因が 2 つ見つかり、同じ PR で直した。**

- [`hook-008`](data/pitfalls/hook-008.json): フックに「直接起動されたときだけ動く」判定を入れていたため、
  リンクを含むパスに置くと何も見ずに exit 0 していた。PR の CI では macOS だけが落ちた。判定を削除し、
  リンク（Windows ではジャンクション）経由で起動するテストを追加。
- [`hook-009`](data/pitfalls/hook-009.json): 実機の確認が、入れ替え前の設定のまま動いていたセッションで
  行われていた（`/hooks` の件数が入れ替え前のファイルと同じだった）。いったん「同じ matcher のエントリが
  2 つあると片方しか登録されない」と取り違えて doctor にエラーを足したが、バックアップの時刻から
  分けた版のままでも 2 hooks で動いていたと分かり、取り消した。テンプレートは 1 エントリに
  まとめた形のまま（どちらでも動く）。インストーラの最後に「起動し直して `/hooks` で 2 hooks を
  確認してから試す」を追加。

起動し直したあとの 2026-09-17 の実機確認（Windows、PowerShell ツール。settings.json は一時的にキットのものに
入れ替え、確認後に元へ戻す手順）: `/hooks` で `Bash|PowerShell` が 2 hooks、
`cmd /c rd /s /q <存在しないフォルダ>`・`powershell -Command "Remove-Item -Recurse <同>"`・
`git -C <worktree> push --force nowhere` の 3 つは `[guard-destructive] BLOCKED`、
`Write-Output "rm -rf is blocked"` はそのまま実行された。docs/02 に「実機では、2回すり抜けました」を追加。

`guard-destructive.ps1`（PowerShell 版）は別PRで追加した。`test-guard-destructive.mjs --target ps`
で同じ 206 件を当て、pwsh 7.4.6 で全件通過。`install.ps1 -Hook powershell` は 4 つとも `.ps1` を
登録するようになった。実装中に踏んだ PowerShell の配列の癖は [`shell-002`](data/pitfalls/shell-002.json)。

### deny に無いもののうち、4 つだけ足した（PR #34）

競合調査で名前が挙がっていた 4 つ（`find . -delete`、`gh repo sync --force`、`git stash drop`、
`git checkout -- .`）は、どれも deny に対応する行が無い。PR #30 の時点では「deny に書いてあるものを
deny が一致しない形でも止める」という範囲に絞っていたため、保留にしていた。

**入れる（2026-09-18 判断）:** `find -delete`、`git stash drop` / `git stash clear`、
`gh repo sync --force`、`gh repo delete`。理由は、消えたものが戻らない点が deny の破壊系コマンドと
同じだから。`find -delete` は `rm -rf` と同じことを別の綴りでやる。`git stash drop` / `clear` は
コミットされていない変更を捨てる。`gh repo sync --force` はローカルではなくリモートを上書きする
（force push と同じ）。`gh repo delete` はリポジトリそのものを消す。

**入れない:** `git checkout -- .` と `git restore`。捨てるのは未コミットの変更だけで、
エージェントが普通にやる操作（生成物の破棄、部分的な取り消し）と見分けがつかない。
止めると誤検知のほうが多くなると判断した。必要なら次の版で、引数が `.` のときだけ、
などの形で見直す。

テストは 219 件（`--target ps` は 218 件。差の 1 件は hook-008 のリンク経由起動テストで、
Node 版のファイルにしか当てられない）。フック本体は
`find` の引数に `-delete` があるか、`git stash` のサブコマンドが `drop` / `clear` か、
`gh repo` のサブコマンドが `delete` か、`sync` に `--force` / `-f` が付いているかを見るだけで、
`git stash pop` / `list`、`gh repo sync`（フラグなし）、`gh pr create`、`find -print` は通す。

**残り（このPRの外）:**


## 基本開発で完了したこと

- [x] 設定テンプレートの形式修正と、読み取り専用の doctor。
- [x] SQL ファイル・文境界の検査、完全一致・期限付き・一度限りの承認、承認ツールの配置。
- [x] 秘密ファイルのシェル読み取り検査。Windows パス、`.exe`、公開テンプレート例外の判定修正。
- [x] インストーラの事前検査、バックアップ保持、既存ファイルのスキップ。
- [x] 自動更新の操作途中・未追跡ファイル・サブモジュール保護、失敗の分類、非対話設定、dry-run。
- [x] 落とし穴レコードの形式検証・静的検査・インデックス生成、文書マーカー検査。
- [x] 単体試行、既存設定への手動取り込み、復元の手順（docs/14〜16）。
- [x] 基本6スイートの一括検証。実行環境の選択と、失敗・未検証を分ける JSON レポート。
- [x] 全11スイートの Linux / Node 統合検証と、設定説明の手動照合。
- [x] 権限のパス側グロブを実測し、秘密ファイルの Write / Edit 保護を確定した。
  `Read(...)` 単独の deny は Edit / Write の両方を止める（`Edit(...)` 単独の deny が Write のみ止め
  Read には漏れるのと非対称）。ルート直下の9記法（素 / `./` / `**/` / `./**/` / `//**/` と
  サフィックス・プレフィックス・dot ファイルの組み合わせ）が Claude Code 2.1.272 でも一致してブロック
  されることを確認。詳細は [実測 第2回](measurements/2026-09-10-modes-and-paths.md)。
- [x] `disableAutoMode` と `disableBypassPermissionsMode` の値・置き場所を実測で確定した。
  有効な値は `"disable"`（文字列）のみで、`permissions` の中に置く必要がある。トップレベルに
  `true` を置く形式（無効値）は、単に無視されるのではなく "Settings Error" となり、
  **allow / deny / ask を含む settings.json 全体がスキップされる**。現在の
  `kit/claude/settings.json` は PR #10（2026-09-14）で既に正しい形（`permissions` の中に
  `"disable"`）になっており、今回の実測はその修正が実機で正しく動くことの確認になった。
- [x] GitHub Actions が実際にステップを実行して成功する。2026-09-15、課金停止が解消し、
  main への push で test.yml の Ubuntu / Windows / macOS 全ジョブが Success を確認した
  （Windows は約10分かかるが正常。以前の「18ジョブ全部 steps:0」という課金エラーとは別物）。
- [x] Windows PowerShell 5.1 / PowerShell 7 で統合版を実行する。
  2026-09-10 に Windows PowerShell 5.1 で基本6スイート成功。2026-09-15 に PowerShell 7.6.6
  （Node v24.13.0）を導入し、同じ基本6スイート（installed-approval / installers / pull-all /
  guard-secrets / guard-sql / sql-boundaries）が全て合格。origin/main の一時 worktree から実行した。
- [x] Windows / macOS の Node で統合版を実行する。
  Windows は 2026-09-10 に実行済み。macOS は手元に実機が無いため、`test.yml` の macOS ジョブに
  `verify-installers.mjs --suite core --target node --json` を手動実行（`workflow_dispatch`）
  専用のステップとして追加し（PR #21、main push・PR では動かずコストを増やさない）、
  2026-09-15 に手動実行で Ubuntu / Windows / macOS 全ジョブ Success、macOS のこのステップは
  43秒で完了した。
- [x] 別ユーザーの素の環境で、新規導入を確認した。2026-09-15、同一PCに新規ローカルユーザー
  （`~/.claude` が存在しない状態）を作成し、そこにリポジトリをコピーして
  `node kit/scripts/install.mjs` を実行。`CLAUDE.md` / `hooks/guard-sql.mjs` /
  `hooks/guard-secrets.mjs` / `scripts/approve-ddl.mjs` / `settings.json` が正しく書き込まれ、
  `doctor.mjs` は `static-pass`、`test-guard-sql.mjs` 44/44、`test-guard-secrets.mjs` 65/65
  で合格。VM は使わず新規ローカルユーザーで代用した。
- [x] `agent-readonly-role.sql` の検証5項目を実 DB で確認した。2026-09-15、専用 Supabase
  プロジェクト（空テーブル）で `agent_readonly` ロールを作成し、特権フラグ4つ
  （rolsuper/rolbypassrls/rolcreatedb/rolcreaterole）が全て false、
  `has_table_privilege` / `has_schema_privilege` で SELECT のみ許可・
  INSERT/UPDATE/DELETE/CREATE が拒否されることを確認。検証後ロールは削除済み。
  副産物: guard-sql がシェル経由のコマンドで文字列リテラルを伏せないため、
  `has_schema_privilege(...'CREATE')` のような無害な SELECT を誤って DDL として
  ブロックすることがある（false positive、実害なし）。Supabase の `postgres` ロールは
  完全なスーパーユーザーではなく、他ロールの `REASSIGN`/`DROP OWNED` には事前に
  `GRANT <role> TO postgres` が必要と判明、ファイルの削除手順に追記した。
- [x] DDL 承認フローと Claude Code 本体でのフック接続を実機で確認した。2026-09-16、
  事前に作った `aiwftest` ユーザーではなく、本体アカウントで
  バックアップ→`install.mjs --skip-claude-md` で一時的に kit を上書き→確認→復元、という
  実測第1回・第2回と同じパターンで行った（対話認証が要る2つ目の Claude Code セッションを
  用意せずに済むため）。Claude Code に実際に `psql -c "select 1;"` / `psql -c "drop table
  nothing;"` / `cat .env` / DDL（ALTER、承認あり・なし・使い切り）を実行させ、
  select は通過・DROP は拒否・`cat .env` は `guard-secrets` で拒否・承認済み ALTER は
  1回だけ通過し2回目は再拒否、をすべて確認した。この過程で実際のバグを2件発見し、
  [PR #23](https://github.com/ponponpon888/ai-workforce/pull/23) で修正・マージ済み。
  - **hook-004**: `settings.json` の Supabase/Postgres/Neon/PlanetScale matcher が
    固定接頭辞（`mcp__[Ss]upabase__.*` 等）で、実機のツール名
    `mcp__claude_ai_Supabase__list_projects`（コネクタ名が接頭辞に挟まる）に一致しなかった。
    さらに `guard-sql.mjs`/`guard-sql.ps1` 自身が持つ内部の防御的二重チェックにも
    同じ固定接頭辞パターンがあり、settings.json 側だけ直しても発火しなかった。両方を
    「ツール名のどこかに製品名を含めば一致」という緩い形に統一した。
  - **hook-005**: DDL 承認が必要なときの BLOCK メッセージが表示する「Statement:」が、
    実際に承認対象となる完全な文字列（tool_input の生の値）ではなく `;` で分割した先頭断片
    だったため、シェル経由の呼び出しでは末尾の閉じ引用符やセミコロンが表示から欠け、
    その表示をそのまま承認しても別のハッシュになり通らなかった。表示を承認対象そのものに
    直した（mjs / ps1 両方。2026-09-16、Windows 実機で両方とも `test-guard-sql` 45/45 を確認）。

## v0.1 までに終わらせること

- [x] Windows で「承認は一度限り」が破れる問題を直した。`guard-sql.mjs` の `isApproved()` は
  `renameSync` の原子性に頼っていたが、Windows では 6 並列の 10% 程度で 2 プロセスが同一の
  承認を通過していた。排他生成ロックで取得を絞り、120 ラウンドで異常 0 件。
  PowerShell 版は経路が異なり 90 ラウンドで異常なしのため未変更。
  詳細は [統合状況](docs/17-integration-status.md)。
- [x] 新規導入した素の環境で、実際にDDL承認フロー（`approve-ddl`）と設定の復元手順を確認した。
  上記のとおり 2026-09-16、本体アカウントでのバックアップ／一時上書き／復元で確認済み
  （新規導入自体は `aiwftest` で確認済みだったものと合わせて、両方とも完了）。
- [x] Claude Code 本体でのフック接続の実地確認を行った。上記のとおり 2026-09-16、
  `select 1;` / `drop table nothing;` / `cat .env` / DDL 承認フローのすべてを
  実際に Claude Code に実行させて確認し、2件の不具合（hook-004, hook-005）を発見・修正した。
- [x] [PR #23](https://github.com/ponponpon888/ai-workforce/pull/23) をレビューし、マージした。
  2026-09-16〜17、`test-guard-sql.mjs`（45/45）・`test-guard-sql.ps1`（45/45、Windows 実機）・
  `test-doctor.mjs`（28/28）・`lint-pitfalls.mjs`（6 pass / 0 violation）をすべて確認してから
  squash マージ。`data/pitfalls.index.json` はサンドボックス側の手計算版に2箇所のズレ
  （detection.message の追記漏れ、ci-001 の origin 見出し表記の既存の古さ）があり、
  実際に `build-pitfall-index.mjs` を実行して正しい版に置き換えてから確定した。
- [x] リポジトリをpublicにした。2026-09-17、事前に`ci/cut-actions-minutes`（PR #24、
  docsのみのpush/PRをCI対象外に・macOSジョブを`workflow_dispatch`専用に）をマージし、
  コミット履歴の簡易的な秘密情報チェック（該当なし）、README / README.en の
  テストケース数の古い表記（44→45）の修正を済ませてから切り替えた。
- [x] main 上での CI（test.yml）の成功確認。public化後、`ci/restore-macos-on-public`
  （PR #25）でmacOSをpush/PR対象に戻し、mainで3OS実行を確認する運用に戻した。
- [x] guard-config（上記参照）のレビューとマージ。[PR #26](https://github.com/ponponpon888/ai-workforce/pull/26)・
  [PR #27](https://github.com/ponponpon888/ai-workforce/pull/27)・
  [PR #28](https://github.com/ponponpon888/ai-workforce/pull/28)・
  [PR #29](https://github.com/ponponpon888/ai-workforce/pull/29)。
- [x] README / README.en を4フック（guard-sql / guard-secrets / guard-config / guard-destructive）を
  並べる形に更新した。「5分で入れる」には、入れたあと Claude Code を起動し直して `/hooks` で
  件数を確認する手順を追加（hook-009）。
- [x] [CHANGELOG.md](CHANGELOG.md) を追加した（v0.1.0 の中身・実測で確定したこと・既知の制約）。
- [x] v0.1.0 のタグ付けとリリース。2026-09-18、この項目を閉じた PR をマージした時点の main に
  `v0.1.0` を打ち、GitHub の Releases に [CHANGELOG](CHANGELOG.md) の v0.1.0 の中身を載せた。
- [x] guard-destructive（PR #30）の Windows 実機確認と test.yml への追加。実機確認で hook-008（フックの不具合）と hook-009（確認手順の落とし穴）を発見・対処した。
- [x] guard-destructive のマージ。[PR #30](https://github.com/ponponpon888/ai-workforce/pull/30)（本体）・
  [PR #31](https://github.com/ponponpon888/ai-workforce/pull/31)（PowerShell 版、Windows PowerShell 5.1 の CI も通過）・
  [PR #32](https://github.com/ponponpon888/ai-workforce/pull/32)（README）・
  [PR #34](https://github.com/ponponpon888/ai-workforce/pull/34)（deny に対になる行がない 4 つ）。

Set-Content の別名 `sc` を deny に追加しない判断も、下記の制約として保持します。

## 基本版の制約と判断

- `rm` の全フラグ変種を権限ルールだけで止める保証はない。通常の削除まで禁止する一律 deny は追加しない。
  フラグ変種と、deny が一致しない呼び方（`bash -c`、`/bin/rm`、`git -C` など）は guard-destructive で止める（perm-006）。
- Read の権限ルールとシェル側の秘密ファイルガードは判定範囲が異なる。ガードには文書・ソースコードの例外がある。
- `Set-Content` の一律 deny は追加しない。将来追加する場合も `sc.exe` を巻き込む `sc` の記述を避ける。
- SQL コマンドの引用文字列にも反応する場合がある。基本版では保守的な検査を維持し、テストペイロードはファイルと標準入力で渡す。
- 秘密ファイルガードはシェル言語全体を解析しない。内部エラー時の許可も含め、敵対的な回避を完全に防ぐ境界ではない。
- 自動更新には全体のタイムアウトや排他ロックがない。任意の認証ヘルパーの停止や同時操作まで保証しない。
- 設定の静的検査は Claude Code 本体の動作証明ではない。現在のテンプレート値と実機測定を区別する。
- MCP ツール名の接頭辞はコネクタごとに変わりうる（実測: `mcp__claude_ai_Supabase__list_projects`）。
  matcher やフック内部のツール名チェックを書くときは、固定接頭辞ではなく部分一致で書くこと（hook-004）。
- guard-config はパス名の文字列一致であり、`git checkout` での古いコミットへの巻き戻しや
  パッケージスクリプト、エディタ拡張機能経由の書き換えはカバーしない（hook-006）。
- guard-destructive もコマンド文字列を読むだけで、スクリプトファイル・`npm run`・Makefile の中身、
  `ssh` / `docker exec` の先、見えないところで代入された変数は追えない。境界が必要ならサンドボックス。
- guard-config の `ConfigChange` 層は「実行中セッションへの反映」を止めるだけで、ディスク上の
  ファイルは元に戻らない。Claude Code が起動していない間の書き換えは検知できず、次回起動時に
  そのまま「起動時の設定」として読み込まれる（hook-007）。

## 基本版以降

- MySQL / SQLite の SQL 検査、案件別テンプレート。pull-all の shell 版は実装した
  （POSIX シェル版。Node 版と同じフィクスチャで 73/73。移植の過程で、PowerShell 版だけが
  ドット始まりのリポジトリフォルダを取りこぼしていたこと（shell-003）が見つかって直した）。
- 落とし穴レコードの追加、Issue からの受け入れ手順、残りの英訳。
- Vercel の権限調査と開発速度の実測。
- 前身 `ai-workforce-os` のログ整理は別リポジトリの作業として扱う。今回は削除していない。
- サブディレクトリ・dot ディレクトリの「通るはず」対照の再設計（実測第2回で対照がディレクトリ全体を
  覆う別の deny 行の中に置かれてしまい機能しなかった）。PowerShell ツール経由の書き込み
  （`Set-Content` 等）が Edit / Write ツールの deny を迂回できるかの検証も未着手。
- `actions/checkout@v4` / `actions/setup-node@v4` が Node.js 20 廃止に伴い Node 24 に
  強制されている旨の warning が CI に出ている（実害なし）。手が空いたときにバージョンを上げる。
- ローカルの `C:\Dev\ai-workforce` チェックアウトの整理。開発は GitHub（main）が正本になり
  ローカルでは行わなくなったため、古いブランチ（`feat/pitfall-records` 上の未push2コミット、
  うち1つは意図しないマージコミット）と、残存する検証用 worktree（`ai-workforce-cg-verify` /
  `ai-workforce-pr18-verify` / `ai-workforce-verification`）の要否を確認して片付ける。
- 検証用に作成したもの: ローカルユーザー `aiwftest`（パスワード変更のため `net user aiwftest`
  で unlock 済み）と `C:\Users\Public\ai-workforce-test`。承認・復元の確認が終わったら、
  `net user aiwftest /delete` と対象フォルダの削除で片付ける。
- ~~guard-sql の false positive（シェル経由コマンドで文字列リテラル内の DDL キーワードに反応する）
  を塞ぐか、既知の制約として残すかを検討する。~~ → 判断した（2026-09-18）。**既知の制約として
  残す。** 安全に塞ぐには guard-destructive と同水準の文法ごとのレクサーが要り、1 本の正規表現や
  SQL 文法の無害化をシェル文字列に当てる安易な形では、過去に一度実際に踏んだ「賢くしたせいで
  TRUNCATE が検査から外れる」失敗（`docs/02` の「3 つ目は、賢くしたせいで空きました」）を
  繰り返しかねない。誤検知は安全側（ブロック）に倒れるもので、危険な SQL を通す穴ではないため、
  guard-destructive 相当のテスト網羅を用意できるまでは塞がない。記録: `docs/02` の新設節
  「シェル経由のコマンドは無害化していません（既知の誤検知）」と
  [hook-010](data/pitfalls/hook-010.json)（`status: open_recorded`）。
- 落とし穴レコード132件の追加投入と、`checks` を回す linter 本体（linter は v0.1 で完成済みのため、
  ここは純粋にレコードのシード追加のみ）。
- ~~競合調査で見つかったもう一つの穴（`cd /tmp && rm -rf x` 等が deny をすり抜ける）~~ → 前提の半分は
  現行の Claude Code では解消済みと判明。残りの本当に抜ける形は guard-destructive で対応（上記、PR #30）。
  `find . -delete`、`gh repo sync --force`、`git stash drop`、`git checkout -- .` は deny にも無いため
  PR #30 では広げていなかった。→ 判断した（下記「deny に無いもののうち、4 つだけ足した」）。
- ~~guard-configのConfigChange層の限界（hook-007）を補うため、`SessionStart`フックで
  settings.jsonのハッシュ（またはpermissions/hooksの内容）を既知の値と照合し、Claude Code
  が起動していない間に書き換えられていた場合は警告する仕組みを検討する。~~ → 実装した
  （2026-09-18）。公式ドキュメント確認の結果、`SessionStart` は exit code も
  `decision`/`permissionDecision` も無視され、**起動そのものは原理的にブロックできない**
  （プラットフォーム側の制約）。そのため「警告どまり」と判断し、guard-config.mjs/.ps1 に
  `known-good/settings.json` という基準ファイルを追加（`approvals/` と同じく
  `PROTECTED_SUBPATHS` で保護）、SessionStart（startup/resume）のたびに現在の
  settings.json と比較して不一致なら `additionalContext`/`systemMessage` に WARNING を出す形にした。
  基準が未作成のときは初回起動時に静かに採用（TOFU）。再記録は
  `kit/scripts/record-settings-baseline.mjs`/`.ps1` を人が手で実行する（`approve-ddl.mjs`
  と同じ信頼モデル）。副産物として ConfigChange が読んでいたペイロードのフィールド名の
  誤り（`source` → 正しくは `config_source`）も見つけて直した。記録: `docs/02` の新設節
  「SessionStart で、起動していない間の書き換えにも気づけるようにしました」と
  [hook-011](data/pitfalls/hook-011.json)（`kind: limitation`, `status: open_recorded`
  — プラットフォーム制約により「警告」以上には塞げないため）。hook-007 自体は
  `kind: behaviour` のため `status` を持てず、`related` に hook-011 を追記した。
