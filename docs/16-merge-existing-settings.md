# 既存設定へフックだけ取り込む

既に Claude Code の `settings.json` を運用している人向けの手順です。
Node 版インストーラのスキップ指定で既存設定と CLAUDE.md を保ち、必要なフックを手動で追加します。
以下はリポジトリのルートから PowerShell で実行します。Node が必要です。

## 1. 比較用の設定を一時フォルダに生成する

```powershell
$stageDir = Join-Path ([IO.Path]::GetTempPath()) ('aiwf-preview-' + [guid]::NewGuid().ToString('N'))
node kit/scripts/install.mjs --claude-home "$stageDir" --skip-claude-md
if ($LASTEXITCODE -ne 0) { throw '比較用の生成に失敗しました' }
$previewSettings = Join-Path $stageDir 'settings.json'
Get-Content -LiteralPath $previewSettings -Raw -Encoding UTF8
```

この段階で書き込むのは一時フォルダだけです。生成した設定の `hooks.PreToolUse` を比較資料にします。
**生成された `command` は一時フォルダを指すため、そのまま実環境へコピーしません。**
この手順で取り込むのはフックだけです。`permissions`、承認モードなどの設定はコピーしません。
テンプレートの設定形式の修正は別の PR #10 で扱っており、この文書はその変更を含みません。

## 2. 配置先を確認し、既存設定を退避する

Claude Code を終了してから進めます。下記の配置先が実際に使っている設定ディレクトリと違う場合は変更してください。
既存の設定が有効な JSON オブジェクトであることを前提とします。

```powershell
$targetDir = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.claude'
$settingsPath = Join-Path $targetDir 'settings.json'
if (-not (Test-Path -LiteralPath $settingsPath -PathType Leaf)) { throw '既存の settings.json がありません' }
$parsed = Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
if ($null -eq $parsed -or $parsed -isnot [pscustomobject]) { throw 'JSON のルートがオブジェクトではありません' }
$backupPath = $settingsPath + '.before-merge.' + [guid]::NewGuid().ToString('N')
Copy-Item -LiteralPath $settingsPath -Destination $backupPath -ErrorAction Stop
Write-Host "退避先: $backupPath"
```

## 3. フックのファイルを配置する

まず変更予定を確認します。

```powershell
node kit/scripts/install.mjs --claude-home "$targetDir" --skip-settings --skip-claude-md --dry-run
if ($LASTEXITCODE -ne 0) { throw '事前確認に失敗しました' }
```

予定を確認した後、次を実行します。

```powershell
node kit/scripts/install.mjs --claude-home "$targetDir" --skip-settings --skip-claude-md
if ($LASTEXITCODE -ne 0) { throw 'ファイル配置に失敗しました。設定編集へ進まないでください' }
```

`hooks/guard-sql.mjs`、`hooks/guard-secrets.mjs`、`scripts/approve-ddl.mjs` を配置します。
同名ファイルがあればバックアップして置き換えるため、独自編集がある場合は先に比較してください。
`settings.json` と `CLAUDE.md` はスキップされます。出力に表示される2本の `node "..."` が実際の配置先のコマンドです。

## 4. エディタで必要な登録だけ追加する

既存の `settings.json` と比較用の設定をエディタで開きます。

| 既存設定の状態 | 編集する箇所 |
|---|---|
| `hooks` がない | ルートへ `hooks` オブジェクトを追加し、その中に `PreToolUse` 配列を作る |
| `hooks` はあるが `PreToolUse` がない | 既存のイベントを保ち、`PreToolUse` 配列を追加する |
| `PreToolUse` がある | 配列内の既存要素を保ち、必要な登録を追加する |
| 同じガードが登録済み | matcher と command の実パスを照合し、重複追加せず既存登録を確認する |

比較用の `hooks.PreToolUse` には SQL 用と秘密ファイル用の2要素があります。
必要な要素の `matcher` と内側の `hooks` を取り込み、`command` を手順3で表示された対応するコマンドへ置き換えます。
SQL 用の matcher だけをコピーして秘密ファイル用の command を組み合わせる、といった取り違えを避けてください。
既存の matcher が同じでも、別のフックであれば残します。

JSON の文字列ではバックスラッシュと引用符をエスケープします。例えば表示が
`node "C:\Users\Alice\.claude\hooks\guard-sql.mjs"` なら、JSON 内では次の値になります。
パスは例なので、実際の出力へ置き換えてください。

```json
{
  "command": "node \"C:\\Users\\Alice\\.claude\\hooks\\guard-sql.mjs\""
}
```

これは command の書き方だけの例で、settings.json 全体ではありません。
ルートの `hooks` キーを二重に作らず、既存の権限設定・他イベント・他のフックを残します。

## 5. 差分と構文を確認する

UTF-8 で保存し、次で JSON の構文を確認します。

```powershell
$checked = Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
if ($null -eq $checked -or $checked -isnot [pscustomobject]) { throw 'JSON のルートがオブジェクトではありません' }
Write-Host 'JSON object: OK'
```

エディタで退避版との差分を確認し、変更が選んだフック登録だけであること、一時フォルダのパスが残っていないことを確かめます。
構文チェックは Claude Code の設定受理やフック接続を証明しません。
[単体試行](14-try-guard-sql.md)でガード自体を確認し、Claude Code 再起動後の設定読み込み・接続確認は別途行ってください。
接続確認に本番 DB や実際の秘密ファイルを使わないでください。
戻す場合は [復元手順](15-restore-after-install.md)を参照し、今回の `.before-merge.*` を退避版として扱います。

## 確認範囲

Linux / Node で一時配置とスキップ指定による既存2ファイルの保持を確認しています。
PowerShell 5.1 / 7 での本文コマンド実行、Claude Code 本体の設定受理・接続は未検証です。
