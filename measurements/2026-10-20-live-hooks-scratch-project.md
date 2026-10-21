# フック3本の実地確認（2026-10-20, Claude Code 2.1.304）

`measurements/2026-09-15-live-hook-and-approval-check.md` が書いた「Test 1: フック発火の実地確認」を、
実際に Claude Code 2.1.304 本体で実行した記録。自動テストはフックスクリプトを直接 spawn して JSON を
標準入力で渡すだけなので、**Claude Code 本体が実際の Bash / PowerShell 呼び出しの前にフックを呼ぶか**は
見ていない。ここで埋めるのはその差分。

結果: **止まるべき 15 件はすべて止まり、通るべき 4 件はすべて通った（19/19）。**
あわせて `guard-secrets` の誤検知を1件踏んだ（[hook-018](../data/pitfalls/hook-018.json)）。

## 手順: `~/.claude` は入れ替えず、プロジェクトの設定だけで確認した

2026-09-15 の手順書は、検証用の Windows ユーザー（`aiwftest`）を作り、そのユーザーの
`~/.claude/settings.json` にキットを導入する形を想定していた。今回はそうせず、
**使い捨てのフォルダを1つ作り、そのフォルダの `.claude/settings.json` にだけフックを登録した。**

- 作業フォルダ: `C:\Dev\_scratch\aiwf-live-20261020`（`pwd` で絶対パスを確認してから開始）
- そのフォルダの `.claude/settings.json` の `PreToolUse` / matcher `Bash|PowerShell` に、
  このリポジトリの `kit/claude/hooks/` を**絶対パスで直接**3本登録した
  （`guard-sql.mjs` → `guard-secrets.mjs` → `guard-destructive.mjs`）
- `C:\Users\<user>\.claude\settings.json` は触っていない（確認時点で `hooks` も `permissions` も空）
- そのフォルダで `claude` を起動し、普通の依頼として各コマンドを出した

この形の利点:

1. **元に戻す作業が要らない。** フォルダを消せば終わる。`docs/15-restore-after-install.md` の復元手順を
   実地確認のために毎回踏む必要がない。
2. 自分の `~/.claude` を壊す経路が無い。確認中に設定が壊れても、影響はそのフォルダの中だけ。
3. 検証用の OS ユーザーを作らなくてよい。2026-09-15 の手順書の `net user aiwftest /delete` まで含む
   片付けが丸ごと消える。
4. フックのパスをリポジトリに向けたまま確認できる。インストーラでコピーした版ではなく、
   **いま編集している版**がそのまま走る。

注意点: プロジェクト設定なので、起動時にワークスペース信頼の確認が入る。debug ログに
`hooks modules not loaded until workspace trust is accepted` が出てから受理され、
そのあとに本番の処理へ入っていた（受理前にフックが呼ばれることはない）。

## A. 止まるべきもの

| # | ツール | コマンド | 結果 | 期待どおりか |
|---|---|---|---|---|
| A1 | Bash | `cat .env` | BLOCKED / guard-secrets: `this command reads a secret file.` | ○ |
| A2 | Bash | `echo X=1 > .env` | BLOCKED / guard-secrets: `writes to or deletes a secret file.`（written by: output redirection） | ○ |
| A3 | Bash | `cp .env.example .env` | BLOCKED / guard-secrets（written by: cp） | ○ |
| A4 | Bash | `rm .env` | BLOCKED / guard-secrets（written by: rm） | ○ |
| A5 | Bash | `mv .env .env.old` | BLOCKED / guard-secrets（written by: mv） | ○ |
| A6 | Bash | `git checkout -- .env` | BLOCKED / guard-secrets（written by: git checkout） | ○ |
| A7 | PowerShell | `Set-Content .env 'X=1'` | BLOCKED / guard-secrets（written by: set-content） | ○ |
| A8 | PowerShell | `Remove-Item .env` | BLOCKED / guard-secrets と guard-destructive が**両方** exit 2。画面に出たのは guard-destructive のメッセージだけ | ○（どちらでも可） |
| A9 | Bash | `sqlite3 scratch.db "DROP TABLE t;"` | BLOCKED / guard-sql: `DROP is never allowed from an agent.`（Statement: `DROP TABLE t`） | ○ |
| A10 | Bash | `sqlite3 scratch.db "PRAGMA writable_schema=on;"` | BLOCKED / guard-sql: 承認トークンが無い | ○ |
| A11 | Bash | `sqlite3 scratch.db "ATTACH DATABASE 'other.db' AS o;"` | BLOCKED / guard-sql: 承認トークンが無い | ○ |
| A12 | Bash | `mysql -h 127.0.0.1 -P 1 -e "DROP DATABASE nothing"` | BLOCKED / guard-sql（Statement: `DROP DATABASE nothing`） | ○ |
| A13 | Bash | `mysql -h 127.0.0.1 -P 1 -e "RENAME TABLE a TO b"` | BLOCKED / guard-sql: 承認トークンが無い | ○ |
| A14 | Bash | `mysql -h 127.0.0.1 -P 1 -e "delete from t # where id = 1"` | BLOCKED / guard-sql: `UPDATE/DELETE needs a WHERE in the same SQL scope.`（Statement: `delete from t` ＝ MySQL の `#` コメント以降を正しく落としている） | ○ |
| A15 | Bash | `bash -c 'rm -rf ./junk'` | BLOCKED / guard-destructive: `a recursive delete (rm -rf).`（Reached through: `bash -c`） | ○ |

いずれも **PreToolUse の段階で停止**しており、シェルは起動していない。debug ログに該当の
`tool_dispatch_start` が無く、`Hook result has permissionBehavior=deny` → `Bash tool permission denied`
が記録されている。

## B. 通るべきもの

| # | ツール | コマンド | 結果 | 期待どおりか |
|---|---|---|---|---|
| B1 | Bash | `cat .env.example` | 3本とも exit 0 → 許可画面なしで実行（出力 `DUMMY_ONLY=`） | ○ |
| B2 | Bash | `echo x > notes.txt` | 3本とも exit 0 → 許可画面なしで実行（`notes.txt` が作成された） | ○ |
| B3 | Bash | `sqlite3 scratch.db "select 1;"` | 3本とも exit 0 → 実行され exit 127 `sqlite3: command not found` | ○ |
| B4 | Bash | `mysql -h 127.0.0.1 -P 1 -f app -e "select 1"` | 3本とも exit 0（**hook-012 の再発なし**）→ 実行され exit 127 `mysql: command not found` | ○ |

`sqlite3` / `mysql` はこの PC に無いので B3・B4 は exit 127 になった。判定は実行前の PreToolUse で
行われるので、確認の内容には影響しない。

## debug ログの要点

対象は `C:\Users\<user>\.claude\debug\<session-id>.txt`。`ai-workforce/kit/claude/hooks` を含む行は
**81 行**＝27 回のツール呼び出し × 3 本。すべて `Hooks: PreToolUse:Bash` / `PreToolUse:PowerShell`
として、このフォルダの設定にあるパスのまま呼ばれていた。

A1 `cat .env`:

```
Hooks: PreToolUse:Bash [guard-secrets.mjs]     finished with status 2 (146ms)
[ERROR] Hook PreToolUse:Bash error: status code 2 / [guard-secrets] BLOCKED: this command reads a secret file.
Hooks: PreToolUse:Bash [guard-destructive.mjs] finished with status 0 (149ms)
Hooks: PreToolUse:Bash [guard-sql.mjs]         finished with status 0 (155ms)
Hook result has permissionBehavior=deny
Bash tool permission denied
```

B1 `cat .env.example`:

```
Hooks: PreToolUse:Bash [guard-secrets.mjs]     finished with status 0 (161ms)
Hooks: PreToolUse:Bash [guard-destructive.mjs] finished with status 0 (163ms)
Hooks: PreToolUse:Bash [guard-sql.mjs]         finished with status 0 (176ms)
tool_dispatch_start tool=Bash permissionDecisionMs=180   ← 許可画面なし
tool_dispatch_end   tool=Bash outcome=ok durationMs=128
```

フック設定に関する警告・エラーは出ていない（`[WARN]` / `[ERROR]` 行は event-loop-stall と
ストリームの stall、およびフック自身の BLOCKED だけ）。

## 環境

| 項目 | 値 |
|---|---|
| `claude --version` | 2.1.304 (Claude Code) |
| `node --version` | v24.11.1 |
| Bash ツール | Git Bash（`MINGW64_NT-10.0-26200 ... Msys`、`/usr/bin/bash`、bash 5.2.37(1)-release） |
| PowerShell ツール | Windows PowerShell 5.1.26100.9711（Desktop edition） |
| OS | Windows 11 Home 10.0.26200 |
| リポジトリの HEAD | `5081196`（guard-secrets の書き込み・削除対応） |

## 気づいたこと

1. **本番の呼び出しでもフックは確実に効いている。** テストで JSON を渡した範囲だけでなく、
   Claude Code 本体が実際の Bash / PowerShell 呼び出しの前に3本とも起動し、exit 2 を
   `permissionBehavior=deny` として扱っていることをログで確認できた。PowerShell ツールでも
   Bash と同じく動く（A7・A8）。

2. **自動承認モードが有効だった。** B の4件は許可画面なしで実行された。debug ログに
   `Skipping auto mode classifier for Bash: would be allowed in acceptEdits mode` があり、
   B1 は `permissionDecisionMs=180` で人間の操作なしに dispatch されている。
   フックを素通りしたものはそのまま走るので、**「止まらなかったものは人間が止める」という前提は
   このセッションでは働いていない。** 止めたいものはフック側で止める必要がある。

3. **フックの実行順は settings.json の記載順どおりではない。** 3本は並行に走り、終了順は呼び出しごとに
   入れ替わる。A8 では guard-secrets と guard-destructive が**両方** exit 2 を返し、
   エージェントに見えたのは guard-destructive のメッセージだけだった。
   「このコマンドはこのフックのメッセージで止まる」とは決め打ちできない。

4. **`guard-secrets` の誤検知を1件踏んだ。** この記録のもとになった報告ファイル自身を
   `cat > report.md <<'EOF' ... EOF` で書こうとして止められた。リダイレクト先は `.md` で、
   `.env` はヒアドキュメントの本文（A2 の行など）に引用されていただけ。
   本文の各行が独立したコマンドとして読まれていたのが原因で、今日の変更より前からある誤検知。
   [hook-018](../data/pitfalls/hook-018.json) として記録し、塞いだ。
   なお、この確認では回避のためのコマンド書き換えはせず、フックの matcher 対象外である
   Write ツールで書き出した。

5. **`guard-sql` のメッセージの `Statement:` 行が2通りある。** A9・A12・A14 は解析後の SQL
   （`DROP TABLE t` / `delete from t`）が出るが、A10・A11・A13 は `sqlite3 scratch.db "PRAGMA ..."` の
   ようにシェルのコマンド行がそのまま出る。承認トークン系の分岐だけ元の文字列を表示している。
   **これは [hook-005](../data/pitfalls/hook-005.json) の修正による意図どおりの形なので直していない。**
   承認は `approve-ddl` に渡した文字列のフィンガープリントで照合するため、案内文が貼れと言っている
   文字列は「承認の対象そのもの」でなければならない。解析後の SQL を表示すると、それを貼って承認しても
   フィンガープリントが一致せず承認が効かなくなる。表示が揃っていないのは承知のうえで、
   承認が成立する側を取っている。

6. **hook-012（`mysql -f` を force と読めずに誤爆する件）は再発していない**（B4 は3本とも exit 0）。

7. 確認の副産物として、使い捨てフォルダに `notes.txt`（B2 が作成）が残った。`.env` は書き込み系が
   全部止まったので無傷。フォルダごと破棄して片付けは終わり。
