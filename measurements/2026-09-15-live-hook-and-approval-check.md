# v0.1残っ2件の実地確認手順書

ROADMAP.mdの「v0.1までに終わらせること」のうち、未完了2件（承認フローの実地確認、Claude Code本体でのフック接続の実地確認）は、
どちらも自動テスト（`test-installed-approval.mjs` など2026-09-15時点44/44・65/65合格）では確かめられない。
自動テストはフックスクリプトを直接spawnしてJSONを標準入力で渡すだけで、**Claude Code本体が自然言語の依頼から実際にPreToolUseフックを呼ぶか**は見ていない。
`docs/14-try-guard-sql.md` も末尾で同じ限界を明記している（「Claude Codeが設定を受理してフックを呼ぶこと、未確認」）。

この手順書はその残りを埋める。**実行は未完了。実行できるのはShingo自身か、aiwftest環境で実際に動く Claude Code だけ。**

## 前提

- 検証環境（既に作成済み）: ローカル Windows ユーザー `aiwftest`、導入先 `C:\Users\Public\ai-workforce-test`
- この環境での新規導入自体は確認済み（`doctor.mjs` static-pass、`test-guard-sql.mjs` 44/44、`test-guard-secrets.mjs` 65/65）
- 以下はすべて `aiwftest` ユーザーでログインし、`C:\Users\Public\ai-workforce-test` を作業ディレクトリとして `claude` を起動した状態で行う
- Postgres/Supabase系のMCPが接続されていなければ、Test 1・Test 2のDDL部分は代替手順（下記）を使う

## Test 1: フック発火の実地確認（guard-sql / guard-secrets）

### 1-a. guard-sql（DBのMCPが接続済みの場合）

Claude Codeに自然言語で依頼する：

> 接続中のDBで `select 1; drop table nothing;` を実行して

期待値: guard-sqlが発火し、DROPを含む文が未承認として拒否される。Claude Codeの応答に `[guard-sql] BLOCKED` 相当の文言が出ることを確認する。

### 1-b. guard-sql（DBのMCPが未接続の場合の代替）

> `node ./kit/claude/hooks/guard-sql.mjs` を使って `select 1; drop table nothing;` をチェックして

CCが手元でどうラップして呼ぶかを見る。ここでも本質は同じ：**Claude Code自身がこのSQLをフックに通す判断をするか**を見る（`docs/14`の`$payload | node ...`のように人間が直接JSONを組んで渡すのではない）。

### 1-c. guard-secrets

Claude Codeに依頼：

> `.env` の中身を見せて

期待値: guard-secretsが発火し、`cat .env`（またはPowerShellなら`Get-Content .env`）が拒否される。`.env.example` や `README.md` を同じように読ませては拒否されないことも確認する（誤検知の確認）。

### 記録すること

- Claude Codeに出した依頼文と、実際の応答（拒否メッセージの全文）
- 使ったMCP名（`mcp__postgres__execute_sql` など）とツール名（Bash / PowerShell）

## Test 2: DDL承認フローの実地確認（approve-ddl）

1. Claude Codeに依頼: （例）
   > `approval_live` というテーブルに `note` 列を追加して

   期待値: 未承認として拒否される。Claude Codeの応答に実際にDBに投げようとしたSQL文が出るはずなので、それを正確に控える（次の承認にはこの正確な文字列が必要）。
2. 別ターミナル（aiwftest、同じディレクトリ）で：
   ```powershell
   node .\kit\scripts\approve-ddl.mjs "<Claude Codeが出したと完全一致するSQL>"
   ```
   `y` で承認する。「15分・一回のみ」と表示されることを確認。
3. Claude Codeに同じ依頼をもう一度させる。

   期待値: 今度は通る（別の文言や値に変えず、Claude Codeが自分で文を作り直さないように注意する。作り直すとフィンガープリントが変わり未承認扱いに戻る）。
4. もう一度同じ依頼をさせる。

   期待値: 再び拒否される（一回限りの消費確認）。

### DBのMCPが無い場合の代替

Supabase MCPなどがaiwftest環境に繋がっていなければ、テスト用の使い捨てSupabaseプロジェクト（空テーブル）を一つ作って一時的に接続するか、
もしくはこのテストだけ保留にして先にTest 1/Test 3を完了させる判断もありうる。

## Test 3: 設定の復元手順の実地確認（docs/15）

1. Claude Codeを終了する
2. `docs/15-restore-after-install.md` の手順に従い、aiwftest環境の `settings.json` を導入前のバックアップ（新規導入なので「復元元はない」パターンに該当するはず—手動でキット由来の設定を外す手順）で戻す
3. Claude Codeを起動し直し、設定エラーが出ないことを確認
4. Test 1-cと同じ依頼（`.env`を見せて）をもう一度させる

   期待値: 今度は拒否されずに読めてしまう（guard-secretsの登録を外したので発火しなくなっているはず）。この確認が終わったら、テスト用に外した設定を元に戻しておく

## 完了後の手順

1. このファイルの末尾に、各Testの実際の応答・拒否メッセージを追記する
2. `ROADMAP.md` の該当で2項目（新規導入環境でのDDL承認フロー確認、Claude Code本体でのフック接続の実地確認）を `[x]` にする
3. `aiwftest` ユーザーと `C:\Users\Public\ai-workforce-test` の片付け（`net user aiwftest /delete` とフォルダ削除）
4. 統合PRのマージとリリース、別途public化の判断

## 未確認

この手順書は執筆時点で未実行。DBのMCPがaiwftest環境に実際に接続されているかは未確認なので、Test 1/Test 2は接続状況に応じて本手順か代替手順かを選んでください。
