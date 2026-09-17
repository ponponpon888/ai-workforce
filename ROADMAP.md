# ロードマップ

基本機能の実装と Linux / Node での統合検証は完了しました。v0.1 の公開は実機確認と CI の成功待ちです。
現在の検証数・対象・取り込み元は [統合状況](docs/17-integration-status.md) を参照してください。
過去の Windows 実測は現在の統合版の検証結果ではありません。変更の履歴は Git と measurements に保持しています。

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
  残るは main 上での CI（test.yml）の成功確認と、README・CHANGELOG の確認・タグ付けのみ。

Set-Content の別名 `sc` を deny に追加しない判断も、下記の制約として保持します。

## 基本版の制約と判断

- `rm` の全フラグ変種を権限ルールだけで止める保証はない。通常の削除まで禁止する一律 deny は追加しない。
- Read の権限ルールとシェル側の秘密ファイルガードは判定範囲が異なる。ガードには文書・ソースコードの例外がある。
- `Set-Content` の一律 deny は追加しない。将来追加する場合も `sc.exe` を巻き込む `sc` の記述を避ける。
- SQL コマンドの引用文字列にも反応する場合がある。基本版では保守的な検査を維持し、テストペイロードはファイルと標準入力で渡す。
- 秘密ファイルガードはシェル言語全体を解析しない。内部エラー時の許可も含め、敵対的な回避を完全に防ぐ境界ではない。
- 自動更新には全体のタイムアウトや排他ロックがない。任意の認証ヘルパーの停止や同時操作まで保証しない。
- 設定の静的検査は Claude Code 本体の動作証明ではない。現在のテンプレート値と実機測定を区別する。
- MCP ツール名の接頭辞はコネクタごとに変わりうる（実測: `mcp__claude_ai_Supabase__list_projects`）。
  matcher やフック内部のツール名チェックを書くときは、固定接頭辞ではなく部分一致で書くこと（hook-004）。

## 基本版以降

- MySQL / SQLite の SQL 検査、pull-all の shell 版、案件別テンプレート。
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
- guard-sql の false positive（シェル経由コマンドで文字列リテラル内の DDL キーワードに反応する）
  を塞ぐか、既知の制約として残すかを検討する。
- 落とし穴レコード132件の追加投入と、`checks` を回す linter 本体（linter は v0.1 で完成済みのため、
  ここは純粋にレコードのシード追加のみ）。
