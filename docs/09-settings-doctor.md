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

### guard-config が守るのは「入れた場所」ではありません

この検査を最初に流したときに見つかったことです。`guard-config` は実行時に
`AIWF_CLAUDE_HOME`（未設定なら `~/.claude`）を守る対象として読みます。**自分がどこに
インストールされたかは見ていません。**

つまり `install.mjs --claude-home /opt/claude` のように標準以外の場所へ入れると、
フック自体は `/opt/claude/hooks/` に置かれて登録もされるのに、**守るのは `~/.claude` のまま**です。
実際に使われている `/opt/claude/settings.json` は無防備になります。`AIWF_CLAUDE_HOME` は
いまのところテスト用の抜け道で、文書にも載っていません。

`probe-guards` は、この食い違いを見つけたら警告して `incomplete`（終了コード2）にします。
黙って `probe-pass` にすると、守られていない場所を「守られている」と報告することになるためです。

```
UNKNOWN guard-config.home: guard-config protects /root/.claude, not the home being
probed (/opt/claude). Set AIWF_CLAUDE_HOME=/opt/claude to probe this home instead.
```

**直し方は分かっています**（フック自身の位置から導出する）が、PowerShell 版の対応と
既存テストの更新を伴うため、このPRでは塞いでいません。
[hook-013](../data/pitfalls/hook-013.json) に記録しています。

```powershell
node kit/scripts/test-doctor.mjs
node kit/scripts/test-probe-guards.mjs
node kit/scripts/test-probe-guards.mjs --target ps   # PowerShell 版のフックを検査する
```

テストは一時ディレクトリだけを使い、異常な設定の検出に加えて「設定に書かれたコマンドを実行しない」「設定を変更しない」「不正JSONの内容を出力しない」ことを確認します。
