# 15. 導入前の状態へ戻す

このキットはClaudeホームの設定・説明・フックを更新します。戻すときは、まず参照する設定を戻し、
フックが呼ばれなくなったことを確認します。以下は操作手順の文書で、実行済みの復元ではありません。

## 1. 使用中のセッションを終了し、対象を確認する

Claude Codeを終了してから作業します。独自の導入先を指定した場合は、同じパスを使ってください。
リポジトリ内のsettings.jsonではなく、実際に導入したClaudeホームのファイルが対象です。

```powershell
$claudeDir = Join-Path $HOME '.claude'
Get-ChildItem -LiteralPath $claudeDir -File |
    Where-Object { $_.Name -like 'settings.json*' -or $_.Name -like 'CLAUDE.md*' } |
    Select-Object Name, LastWriteTime, Length
```

## 2. どの戻し方が適切か選ぶ

| 状態 | 戻し方 |
|---|---|
| 導入前のバックアップがあり、その後の編集を残す必要がない | 選んだバックアップを復元 |
| 導入後に設定やCLAUDE.mdを編集した | 現行版を保存し、内容を比較して必要な部分だけ手動で戻す |
| 初回導入で元ファイルがなかった | 復元元はない。自分が追加した設定と説明だけを手動で取り除く |
| skip指定で設定やCLAUDE.mdを更新しなかった | そのファイルは原則として復元不要。手動追加した部分を確認 |

バックアップは `settings.json.bak.*` / `CLAUDE.md.bak.*` です。
最新のバックアップが導入前の状態とは限りません。再インストール前のキット設定が入っている場合もあります。
日時だけで選ばず、内容をローカルで比較してください。設定内容には私的な情報が含まれる場合があります。

## 3. 選んだバックアップから1ファイルずつ復元する

次の例はsettings.json専用です。復元元のファイル名を確認して入力します。
現在のファイルを別名保存してからコピーし、バイト列のハッシュが一致することを確認します。

```powershell
$destination = Join-Path $claudeDir 'settings.json'
$backupName = Read-Host 'Restore source filename (settings.json.bak....)'
if ([IO.Path]::GetFileName($backupName) -ne $backupName -or
    -not $backupName.StartsWith('settings.json.bak.')) {
    throw 'Choose a settings.json backup filename from the listed directory'
}
$backup = Join-Path $claudeDir $backupName
if (-not (Test-Path -LiteralPath $backup -PathType Leaf)) { throw 'Backup not found' }
# Check that the selected backup is JSON before changing the destination.
$restoredSettings = Get-Content -LiteralPath $backup -Raw -Encoding UTF8 |
    ConvertFrom-Json -ErrorAction Stop
if ($null -eq $restoredSettings -or
    $restoredSettings -isnot [System.Management.Automation.PSCustomObject]) {
    throw 'Backup must contain a JSON object'
}
if (Test-Path -LiteralPath $destination) {
    if (-not (Test-Path -LiteralPath $destination -PathType Leaf)) { throw 'Destination is not a file' }
    $snapshot = "$destination.before-restore.$([Guid]::NewGuid().ToString('N'))"
    Copy-Item -LiteralPath $destination -Destination $snapshot -ErrorAction Stop
    Write-Host "Current settings saved to $snapshot"
}
Copy-Item -LiteralPath $backup -Destination $destination -Force -ErrorAction Stop
if ((Get-FileHash -LiteralPath $backup).Hash -ne
    (Get-FileHash -LiteralPath $destination).Hash) {
    throw 'Restored bytes do not match the selected backup'
}
Write-Host 'Restored selected settings backup'
```

この検査はJSONの構文とコピー一致を確認するだけです。Claude Codeの設定として有効かは別途確認が必要です。
CLAUDE.mdも同様に現行版を別名保存し、選んだCLAUDE.md.bak.*から復元できます。JSON検査は不要です。

## 4. 手動で戻す場合

settings.jsonのPreToolUseから、自分がこのキットのために追加したguard-sql / guard-secretsの設定を外します。
他のフック、権限設定、個人設定は残します。キット由来のpermissionsも削除したい場合は導入前の記録と比較し、
自分で追加した項目だけ戻してください。名前だけで他のツールと共用の設定を削除しないでください。
CLAUDE.mdもキット由来の部分だけ戻し、後から追加した指示を残します。

フックファイルやapprove-ddlは、参照がなくなってから必要に応じて片付けます。
ファイルを残しても、このキットの設定からの参照がなくなればそこから起動されません。
Claudeホーム全体を削除する必要はありません。

## 5. 再起動して確認する

Claude Codeを起動し直し、設定エラーがないことと、外したフックが呼ばれないことを確認します。
問題があれば、手順3のbefore-restoreファイルを使って今回の復元前へ戻せます。

インストーラはpull-allの定期実行を自動登録しません。READMEや画面の案内に従って自分で登録した場合だけ、
登録したタスクを確認して無効化してください。フックの設定復元だけでは、そのタスクは停止しません。
承認トークンなどの別ディレクトリも、この手順では削除しません。

PowerShell手順の実行とClaude Codeでの復元後確認は未検証です。
