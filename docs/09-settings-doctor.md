# 設定と導入状態の診断

`doctor.mjs` は、AI Workforce の設定プロファイルと、導入先の標準フック登録を読み取り専用で検査します。設定ファイルに書かれたコマンドは実行しません。設定を修正したり、秘密ファイルを読み出したりもしません。

```powershell
# 配布テンプレートの検査
node kit/scripts/doctor.mjs --template

# 通常の導入先 ~/.claude/settings.json の検査
node kit/scripts/doctor.mjs

# 別の導入先を指定
node kit/scripts/doctor.mjs --claude-home 'C:\Users\example\.claude' --json
```

| 終了コード | 結果 | 意味 |
|---|---|---|
| 0 | static-pass | 対象にした静的チェックに合格 |
| 1 | error | 不正な設定、既知の不一致、登録ファイル不足など |
| 2 | incomplete | 標準登録が見つからない、独自コマンドなどで判定できない |

**static-pass は、Claude Code本体でフックが動いたという意味ではありません。** 診断対象は1つの設定ファイルです。上位設定・案件別設定との合成、ホストのバージョン、インタプリタの有無、フック内容の正しさ、実際の呼び出しは未確認で、JSONにも `hostVerification: "not-performed"` と出します。これはClaude Codeの全設定スキーマのバリデータでもありません。

検査するものは、キットの手動確認プロファイル、権限リストの形、現在参照されないWriteパスルール、フック無効化、PreToolUseの形、正規表現、代表ツール名へのマッチ、timeout、プレースホルダ、標準配置先のファイル存在です。ツール名が異なるMCP接続は別途確認してください。独自のラッパーやargs形式は実行も推測もせず、判定不能として返します。

設定値は2026-09-09に確認した[Claude Code公式の権限仕様](https://code.claude.com/docs/en/permissions)に基づき、`permissions.defaultMode` を `default`、`permissions.disableAutoMode` と `permissions.disableBypassPermissionsMode` を文字列 `disable` に揃えています。パス指定のWriteルールはEditルールと重複していたため除き、Edit/Readの拒否を残しています。過去の実測記録はその当時の環境についての記録であり、書き換えていません。

Claude Codeの対応バージョンは今回実機で確定していません。実利用版で設定を読み込ませて診断表示と有効設定を確認し、無害な対照入力でフックが呼ばれることを確認してください。秘密ファイルや本番DBを動作確認用に使わないでください。公式の[フック仕様](https://code.claude.com/docs/en/hooks)では、command型フックの起動失敗やタイムアウト自体は実行を止めない場合があります。

既存の設定へ反映する際は、設定全体を置き換える前に差分を確認してください。doctorは既存設定を自動変更しません。インストール済みのファイルもこのPRだけでは変更されません。

```powershell
node kit/scripts/test-doctor.mjs
```

テストは一時ディレクトリだけを使い、異常な設定の検出に加えて「設定に書かれたコマンドを実行しない」「設定を変更しない」「不正JSONの内容を出力しない」ことを確認します。
