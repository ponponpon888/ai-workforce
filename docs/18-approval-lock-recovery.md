# 単回承認の排他と、異常終了後の復旧

対象: PR #16 の `bba40e4` を土台にした修正。未マージ・実環境へ未導入。
これはローカル SQL ガードの競合対策であり、中央 Critical Gate の完成ではありません。

## 今回の変更

Node と PowerShell の両ガードが、同じ `<fingerprint>.approval.lock` を排他的に新規作成してから承認を消費します。
Node は `openSync(..., 'wx')`、PowerShell は `FileMode.CreateNew` を使用します。
承認ファイルの移動だけで取得者を決める旧方式には依存しません。

取得者は診断用メタデータを書き込み・flush し、承認の移動、本文と期限の確認、消費、ロック解放までを順に行います。
正常に消費とロック解放が完了した場合だけ許可します。SQL の判定範囲、v2 の本文ハッシュ、15分の期限は変更しません。
`DROP` / `TRUNCATE`、未対応のファイル経由 DDL の禁止も維持します。

ロックは全体ロックではなくフィンガープリント単位です。別の SQL の承認まで恒久停止させません。
空・壊れた内容・古い時刻のロックも有効な停止条件です。年齢・PID を理由に自動削除しません。
取得失敗時は既存ロックを削除せず、専用の `approval-state-unavailable` 診断を返します。
この診断では、通常の「承認して再試行」という案内を出しません。

## 異常終了の扱い

| 停止した位置 | 残り得る状態 | 扱い |
|---|---|---|
| ロック取得直後 | 空の `.lock` と元の `.approval` | 停止を維持 |
| 承認を移動した後 | `.lock` と `.approval.used-*` | 元の承認名へ戻さない |
| 消費した後、ロック解放前 | `.lock` のみ | 未実行と決め付けない |
| 書き込み・移動・消費の I/O エラー | ロックと、その時点の証跡 | 許可せず、復旧確認が必要 |

正常に終了したガードはロックを解放しますが、ガードの終了は DB 操作の終了ではありません。
このフックは外部操作を実行・追跡していないため、ロックや PID だけでは外部の成否を確定できません。

## 復旧手順（人間が実施）

1. 同じ承認ディレクトリを使う全セッション、ガード呼び出し、再試行、承認発行を停止します。
   ロックの PID が存在しないだけでは、他の待機中要求や外部操作の停止を確認できません。
   別ウィンドウ・別エージェント・自動再試行も確認します。
2. 対象プロジェクトの実際の状態、操作ログ、クライアントの実行記録を照合します。
   結果が不明なら停止のままにします。成功していた場合は同じ操作を再実行しません。
3. 診断に出た64文字のフィンガープリントを確認し、その一件の `.approval`、`.approval.lock`、
   `.approval.used-*` を、アクセスを制限した新しい退避先に保全します。
   先に旧承認と使用済みファイルを承認ディレクトリの外へ退避し、ロックは最後に退避します。
   退避に失敗したら停止を維持します。承認ディレクトリ全体の削除、ワイルドカードでの一括解除、
   `.used-*` から `.approval` への復元は行いません。証跡には SQL が含まれる場合があります。
4. 古い呼び出しがすべて終了し、再実行が必要かつ安全と確認できた場合だけ、内容を再確認して新しく承認します。
   保管した古い承認は再利用しません。

新しい自動解除コマンドは追加していません。稼働中プロセスと外部の成否をこのガード単独では証明できないためです。
通常の承認ツールは現状のままなので、ロックがある間に再発行しても解除されません。

## 導入条件と保証の範囲

- 旧版と新版を同じ承認ディレクトリで同時に動かさないこと。旧版は新しいロックを尊重しません。
  全呼び出しを止め、Node / PowerShell の全コピーを揃えてから検証します。
- 一件の承認に対する消費者間の競合を対象とします。承認の発行と消費を並行させないでください。
  現行 v2 は SQL 本文で保存先を決めるため、別発行と古い呼び出しを識別する中央台帳ではありません。
- 同じローカル承認ディレクトリと、排他的作成が機能するファイルシステムを前提とします。
  NFS / SMB / OneDrive 等のネットワーク・同期フォルダーは検証対象外です。
- プロセス異常終了を扱う設計です。電源断・OSクラッシュ後の永続性や、改ざんする同一権限プロセスへの隔離は保証しません。
- 承認者の認証、プロジェクト ID / 本番環境への結び付け、チャットからの申請 API、承認画面、
  外部サービスの重複実行防止は別開発です。`y/N` / `--force` も今回の変更対象ではありません。

## 検証

2026-09-10、Linux / Node v22.16.0 の一時ディレクトリで実施しました。

- `test-guard-sql.mjs`: 既存44件成功。
- `test-sql-boundaries.mjs`: 既存18件と追加14件、計32件成功。
- 6並列を40ラウンド実行し、全ラウンドで許可1件・拒否5件。
- ロック取得・承認移動・消費の各直後にテスト用子プロセスを強制終了し、ロック保持と再利用拒否を確認。
- flush・移動・消費のエラーをテスト用コピーへ注入し、許可せず証跡を保持することを確認。
- 空・古い・壊れた・ディレクトリのロックを用意する4ケースは、旧 Node ガードで許可されることを確認してから修正。

異常終了のテストは、一時ディレクトリへコピーしたガードに停止位置を挿入します。
本体に故障注入用の環境変数やバイパスは追加しません。SQL や入力コマンドは一度も実行しません。
新スイートは既存 `test-sql-boundaries.mjs` から呼ばれるため、その既存検証経路へ組み込まれます。
新しい Actions ジョブ、課金設定の変更はありません。

### Windows で残る確認

Windows / Windows PowerShell 5.1 / PowerShell 7、実際の Claude Code、macOS、実 DB、全統合スイートと CI の成功は未確認です。
Linux の結果を Windows 修正完了とは扱いません。Windows では以下を作業ブランチで実行します。
PowerShell 対象では、追加で Node 3プロセスと PowerShell 3プロセスの混在競合を検証します。

```powershell
node .\kit\scripts\test-guard-sql.mjs
node .\kit\scripts\test-sql-boundaries.mjs
node .\kit\scripts\test-sql-boundaries.mjs --target ps --pwsh powershell.exe
```

40ラウンドへ増やす場合は `AIWF_APPROVAL_STRESS_ROUNDS` を使用します。テスト専用の設定で、ガードには影響しません。

```powershell
$previousRounds = $env:AIWF_APPROVAL_STRESS_ROUNDS
try {
    $env:AIWF_APPROVAL_STRESS_ROUNDS = '40'
    node .\kit\scripts\test-sql-boundaries.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Node approval tests failed' }
    node .\kit\scripts\test-sql-boundaries.mjs --target ps --pwsh powershell.exe
    if ($LASTEXITCODE -ne 0) { throw 'PowerShell approval tests failed' }
} finally {
    $env:AIWF_APPROVAL_STRESS_ROUNDS = $previousRounds
}
```

### 使用する API の根拠

Node の排他的ファイル作成とネットワークファイルシステムに関する注意:
<https://nodejs.org/api/fs.html#file-system-flags>

.NET の `FileMode.CreateNew` と共有モード:
<https://learn.microsoft.com/en-us/dotnet/api/system.io.filemode?view=netframework-4.8.1>
<https://learn.microsoft.com/en-us/dotnet/api/system.io.fileshare?view=netframework-4.8.1>

API の文書化された性質と、今回の実測結果は区別します。
