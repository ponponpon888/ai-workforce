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

## 効いているかを確かめる（probe-guards）

`doctor.mjs` は設定を読むだけで、**フックが実際に落とすかどうかは見ていません**。上の注意書きで
「無害な対照入力でフックが呼ばれることを確認してください」と書いている部分を、毎回同じ形で
実行するのが `probe-guards.mjs` です。

```powershell
node kit/scripts/probe-guards.mjs
node kit/scripts/probe-guards.mjs --claude-home 'C:\Users\example\.claude' --json
```

`settings.json` に登録されているコマンドを**そのままの綴りで**起動し、止めるべき入力と
通すべき入力を渡して終了コードを見ます。パスの間違い、コピーし損ねたフック、Node版と
PowerShell版の取り違え、matcher がツール名を覆っていない、編集して壊れた — どれも静的検査では
static-pass に見えますが、ここで落ちます。

| 終了コード | 結果 | 意味 |
|---|---|---|
| 0 | probe-pass | 登録されている全ガードが、止めるべきものを止め、通すべきものを通した |
| 1 | error | 登録されているのに、期待どおりに動かないガードがある |
| 2 | incomplete | 登録が見つからない、コマンドが起動できないなど、確認できないものがある |

**通す側の検査が半分を占めます。** 全部止めるフックは、何も止めないフックと同じくらい壊れて
いるので、`select 1` や `npm run build` が通ることも毎回確認します。

やらないことも決めてあります。

- **ペイロードの中のコマンドは実行しません。** `rm -rf` も `cat .env` も、読むだけのフックに
  渡す文字列です。DBにも繋ぎません。ファイルも書きません
- **PreToolUse のペイロードしか送りません。** SessionStart は known-good の基準ファイルを
  書き込む経路なので、診断が診断対象の状態を変えないために送りません
- **Claude Code 本体がフックを呼ぶことの証明にはなりません。** それができるのは本体だけです。
  ここで分かるのは「settings.json に書いてあるとおりに起動したとき、フックは仕事をする」まで

### 保存した結果を比較する

`record-probe-reports.mjs` は、保存と比較をまとめるためのCLIです。対象と保存先は毎回明示し、
更新前後は別の呼び出しにします。既存ファイルを上書きせず、基準と出力に同じファイルを指定すると
拒否します。ガード・設定の更新、設定の書き換え、自動ロールバックは行いません。

```powershell
# 更新前: 成功した基準、または失敗を明示した基準レポートを別名で保存する
node kit/scripts/record-probe-reports.mjs before --claude-home 'C:\Users\example\.claude' --output .\before.json
# 利用者がここで必要なガード更新・調査を手で行う。CLIは更新しない。
# 更新後: 同じ対象を別名へ記録し、明示した基準だけと比較する
node kit/scripts/record-probe-reports.mjs after --claude-home 'C:\Users\example\.claude' --previous .\before.json --output .\after.json
```

`before` が `error` ならレポートは保存しますが、成功した基準とは表示せず終了コード 1 です。
`incomplete`、起動失敗、タイムアウト、壊れたレポート、保存失敗は終了コード 2 とし、有効な
probeレポートとして出力先に残しません。`after` は保存済みの基準JSONを検証してから同じ対象を
probeし、結果差分と条件差を分けて出します。`--json` を付けると保存先・probe状態・比較結果をJSONで
出します。保存済みJSONだけを読む `compare-probe-reports.mjs` は従来どおりフックを起動しません。

レポートには schema と固定 probe ID、probe 定義版、日時、OS、Node 版、実際にフックで使った
PowerShell 実行ファイルと版（取得できなければ `unknown`）、設定・対象ガード・使用した共有 lexer の
SHA256だけを残します。設定本文や秘密情報は出力しません。probe 中にこれらをハッシュできない、または
前後で変わった場合は `incomplete` として、同一条件の成功にはしません。
前後のハッシュ一致は、probe の途中で変更して元に戻したことまで検知する保証ではありません。監査や
同時変更の完全な検出ではなく、その実行の開始時・終了時の比較可能性を示すものです。

比較は guard 名と固定 ID で行うため配列順や日時だけの違いは結果差分にしません。想定外の許可、誤検知、
実行異常、未検証、追加・欠落を分け、実行環境・probe 定義・ハッシュの差は条件差として別表示します。
ハッシュが違っても結果自体は比較できますが、同一条件とは言いません。両方が fail のままなら
`UNCHANGED FAILURE` と表示し、正常とは扱いません。不正 JSON、重複 ID、未対応 schema、固定 ID のない
旧レポートは比較不能（終了コード 2）です。

| 終了コード | 比較結果 |
|---|---|
| 0 | 比較可能で、結果・条件差がなく、今回の全 probe が pass |
| 1 | 比較はできたが差分がある、または今回が fail / incomplete |
| 2 | 引数または入力レポートが比較不能 |

この比較コマンドはフック、Claude Code、本番環境、ペイロード内のコマンドを起動しません。前節と同様、
probe の結果は Claude Code 本体との接続確認ではありません。

### guard-config が守るのは「入れた場所」です（以前は違いました）

この検査を最初に流したときに見つかり、その場で直した1件です。

`guard-config` は保護対象の claude home を**実行時に `AIWF_CLAUDE_HOME`（未設定なら `~/.claude`）から
決めていました**。自分がどこにインストールされたかは見ていません。つまり
`install.mjs --claude-home /opt/claude` のように標準以外の場所へ入れると、フック自体は
`/opt/claude/hooks/` に置かれて登録もされるのに、**守るのは `~/.claude` のまま**で、実際に
使われている `/opt/claude/settings.json` は無防備でした。

実測（修正前）:

```
Edit /opt/claude/settings.json   -> exit 0（許可）
Edit ~/.claude/settings.json     -> exit 2（ブロック）
```

**いまは自分の位置から導出します。** インストールされたフックは
`<claude home>/hooks/guard-config.*` に置かれるので、そこから1つ上が「Claude Code がいま
読んでいる home」です。

- `AIWF_CLAUDE_HOME`（PowerShell 版は `-ClaudeHome`）は明示的な上書きとして残っています。
  指定するとその home だけを守ります（テストが一時ディレクトリに固定するための経路）
- 指定が無いときは、**導出した home と `~/.claude` の両方**を守ります。守る範囲を広げるのは
  安全ですが、黙って狭めるのは危険なので、チェックアウトから直接登録されたコピーが
  `~/.claude` を守らなくなる事態は避けています
- ブロック時のメッセージは、一致した方の home を名指しします

[hook-013](../data/pitfalls/hook-013.json) に記録しています。`probe-guards` は、
`AIWF_CLAUDE_HOME` が別の場所を指しているときだけ不一致として警告し、`incomplete` にします。

```powershell
node kit/scripts/test-doctor.mjs
node kit/scripts/test-probe-guards.mjs
node kit/scripts/test-probe-guards.mjs --target ps   # PowerShell 版のフックを検査する
```

テストは一時ディレクトリだけを使い、異常な設定の検出に加えて「設定に書かれたコマンドを実行しない」「設定を変更しない」「不正JSONの内容を出力しない」ことを確認します。
