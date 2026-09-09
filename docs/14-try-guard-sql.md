# 14. SQLガードだけ試す

全部導入する前に、リポジトリ内のNode版SQLガードを単体で試します。
インストーラは実行せず、Claude Codeの設定やデータベースは変更しません。
Node.jsと取得済みのリポジトリが必要です。以下はリポジトリのルートでPowerShellから実行します。

## 1. 実行環境とファイルを確認する

```powershell
node --version
Test-Path -LiteralPath './kit/claude/hooks/guard-sql.mjs'
```

Nodeのバージョンと `True` が表示されることを確認してください。
Nodeが見つからない、または `False` の場合は、先にNodeの導入・作業フォルダを確認します。

## 2. 許可と拒否を1件ずつ試す

次のコードをまとめて実行します。SQLはJSONの文字列としてガードへ渡すだけです。
SQLクライアントやデータベースには接続しません。

```powershell
$probes = @(
    @{ Name = 'SELECT allowed'; Query = 'select 1;'; Expected = 0 },
    @{ Name = 'DROP blocked'; Query = 'drop table aiwf_probe;'; Expected = 2 }
)
foreach ($probe in $probes) {
    $payload = @{
        session_id = 'local-probe'
        hook_event_name = 'PreToolUse'
        tool_name = 'mcp__postgres__execute_sql'
        tool_input = @{ query = $probe.Query }
    } | ConvertTo-Json -Depth 4 -Compress
    $payload | node './kit/claude/hooks/guard-sql.mjs'
    $actual = $LASTEXITCODE
    if ($actual -ne $probe.Expected) {
        throw "$($probe.Name): expected $($probe.Expected), got $actual"
    }
    Write-Host "PASS: $($probe.Name)"
}
```

`PASS: SELECT allowed` と `PASS: DROP blocked` が表示されれば、この2入力の判定は期待どおりです。
DROP側の `[guard-sql] BLOCKED` メッセージは予定どおりの拒否です。
最後のNode終了コードは拒否を示す2のままなので、外側の自動化で単純に成功コードとして扱わないでください。
自動化には次のテストスイートを使います。

## 3. 回帰テストを実行する

```powershell
node './kit/scripts/test-guard-sql.mjs'
if ($LASTEXITCODE -ne 0) { throw 'SQL guard tests failed' }
```

失敗件数0を確認します。このテストは一時ファイル・使い捨て承認トークンを作って検査し、終了時に片付けます。
既存のClaudeホームへインストールせず、SQLそのものは実行しません。

## ここまでで分かること

確認できるのは、このチェックアウトにあるNodeガードがテスト入力を判定できることです。
Claude Codeが設定を受理してフックを呼ぶこと、権限ルールが働くこと、本番DBの保護はまだ確認していません。
通過したSQLが安全だという保証でもありません。

本導入はREADMEのインストール手順へ進み、既存設定がある場合は上書き範囲を確認してください。
この最小手順だけなら導入先の変更はないため、アンインストール操作は不要です。

この文書の2入力と既存44テストは、Linux / Node v24.19.0で確認しました。
PowerShellからの実行とClaude Code本体への接続は未検証です。
