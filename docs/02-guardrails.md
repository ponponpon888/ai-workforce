# 02. 機械的な歯止め

更新: SQLガードのWHERE判定・承認トークン・未対応経路の扱いを変更しました。現在の制限と移行方法は[SQLガードの境界と承認](10-sql-boundaries.md)を参照してください。以下の過去の測定結果は当時の記録です。

English: [02-guardrails.en.md](02-guardrails.en.md)

## 先に断っておくこと

**これは事故を止める仕組みであって、悪意を止める仕組みではありません。**

シェルを持ったエージェントは、原理的にはこの歯止めを回り込めます。承認トークンを自分で書くこともできる。
それでも意味があるのは、実際に起きるのが悪意ではなく**うっかり**だからです。

- 「テストデータを消しておきますね」→ `WHERE` を書き忘れる
- 「スキーマを整理します」→ 使われていると思わなかったテーブルを落とす
- 「マイグレーションを当てます」→ 本番の接続文字列が入っていた

このどれも、悪意ではありません。だから、悪意向けの防御ではなく、
**うっかりが物理的に通らない壁**を置いています。

この線引きを曖昧にしたまま「AI 開発は安全です」と言うのは嘘なので、最初に書いておきます。

---

## 3 層で止める

| 層 | 何をする | 破られ方 |
|---|---|---|
| 1. 指示（`CLAUDE.md`） | AI に「やるな」と伝える | AI が読み飛ばす／文脈が長くなると薄れる |
| 2. 権限（`deny` リスト） | ツール呼び出しをパターンで拒否 | パターンをすり抜ける書き方 |
| 3. フック（`guard-sql`） | 実行直前に中身を解析して落とす | 解析できない形での実行 |

**1 だけでは足りない**というのが出発点です。指示は確率的にしか効きません。
実行前に決定的に落ちる層が要ります。

---

## 層 1: 指示

`~/.claude/CLAUDE.md` の「止まるべき場所」の表。
[01. 2 層の CLAUDE.md](01-two-layer-claude-md.md) を参照。

これは**一次判断**です。ここで止まれば、そもそもツール呼び出しが発生しません。
フックは最後の砦であって、ここを手抜きする理由にはなりません。

---

## 層 2: 権限（deny リスト）

`~/.claude/settings.json` の `permissions.deny`。
パターンに一致するツール呼び出しを、Claude Code 自体が拒否します。

```json
"deny": [
  "Read(.env)",
  "Read(./**/.env.*)",
  "Read(**/*.pem)",
  "Bash(rm -rf:*)",
  "Bash(git push --force:*)",
  "Bash(git reset --hard:*)",
  "Bash(supabase db reset:*)"
]
```

現在の `kit/claude/settings.json` は、`permissions.defaultMode` を `default`、
`permissions.disableBypassPermissionsMode` と `permissions.disableAutoMode` を `"disable"` にしています。
これはテンプレートの設定値です。Claude Code 本体での設定受理・優先順位・動作確認は、
[統合状況](17-integration-status.md) の実機検証として残っています。

> これは**手元の Claude Code** の設定です。私はチャット（Cowork）側では承認をスキップに
> していて、そこにはこの設定が効きません。矛盾しているように見えますが、経路が別です。
> チャット側をどう塞ぐかは [06](06-supabase-mcp.md) と [07](07-github-vercel.md)。

読み取り系（`Read` / `Glob` / `Grep` / `git status` / `git diff`）は `allow` に入れて、
確認を出さない。ここで確認を出すと、数が多すぎて読まれなくなります（[00](00-principles.md)）。

実物: [kit/claude/settings.json](../kit/claude/settings.json)

### deny リストの限界

`Bash(rm -rf:*)` が止めるのは、`rm -rf` の後ろが**空白で区切られている**場合だけです。
`rm -rfv /foo` はフラグが 1 文字伸びただけで抜けます（詳細は後述の「記法が 2 つあって、どちらも効いていました」）。

つまり deny リストは**主要な事故パターンを塞ぐもの**であって、網羅ではありません。
網羅できないことを前提に、層 3 を置いています。deny が一致しない書き方で来た
破壊系のコマンドは、`guard-destructive` フックが拾います（後述の「deny をすり抜ける形の、半分はもう古い話でした」）。

---

## 層 3: フック（guard-sql）

`PreToolUse` フックで、SQL が実行される直前に中身を読んで落とします。

実物: [kit/claude/hooks/guard-sql.mjs](../kit/claude/hooks/guard-sql.mjs)（Windows / macOS / Linux）
／ [guard-sql.ps1](../kit/claude/hooks/guard-sql.ps1)（PowerShell 版、挙動は同じ）

### 何を落とすか

| 判定 | 扱い |
|---|---|
| `DROP` | 常に拒否。人間が手でやる |
| `TRUNCATE` | 常に拒否 |
| `DELETE FROM` に `WHERE` なし | 拒否 |
| `UPDATE ... SET` に `WHERE` なし | 拒否 |
| `CREATE` / `ALTER` / `GRANT` / `REVOKE` / `REINDEX` / `VACUUM` | **承認トークンがある場合のみ通す** |

### 文字列とコメントを先に無害化する

素朴に正規表現をかけると、こうなります。

```sql
insert into notes (body) values ('drop the old flow');   -- 誤検知
select * from t; -- delete from t;                       -- 誤検知
select 'a; b';                                           -- 文の分割を誤る
```

なので、判定の前に一度だけスキャンして、文字列リテラル・ドル引用符・行コメント・
ブロックコメントを潰しています。1 本の正規表現の交替で、
出現位置ごとに最初に一致した種別を採用する形にしているので、
`'--'` のような「文字列の中のコメント記号」も正しく扱えます。

```js
const pattern = new RegExp([
  "'(?:[^']|'')*'",                           // single-quoted literal, '' escape
  '\\$([A-Za-z0-9_]*)\\$[\\s\\S]*?\\$\\1\\$',  // postgres dollar-quoted body
  '--[^\\r\\n]*',                             // line comment
  '/\\*[\\s\\S]*?\\*/',                       // block comment
].join('|'), 'g');
```

無害化したあとで `;` で分割するので、文字列に含まれるセミコロンで文が割れることもありません。

### DDL の承認トークン

DDL は「内容を提示して承認を得てから実行する」というルールにしていますが、
フックは対話できません。そこで、承認を**人間が手で作るファイル**にしました。

```bash
# 人間が、SQL を読んでから自分で叩く
node kit/scripts/approve-ddl.mjs "alter table bookings add column memo text"
```

`approve-ddl` は SQL を空白正規化して SHA-256 を取り、
そのハッシュ名で `~/.claude/approvals/<hash>.approval` を作ります。

フック側は、DDL を見つけたら同じハッシュのファイルを探し、

- **なければ落とす**
- **あれば、使った時点で削除する**（1 回だけ有効）
- **15 分より古ければ落とす**

つまり「承認したその文が、15 分だけ、1 回だけ通る」。
文が 1 文字でも違えばハッシュが変わるので、
承認したのと違う SQL が滑り込むことはありません。

**BLOCK 時に表示する「Statement:」は、承認対象そのものと一致させています。** 承認の判定は
tool_input に渡された文字列全体のハッシュで行うため、表示だけが `;` で分割した先頭断片
だと、シェル経由の呼び出し（`psql -c "alter table t add c;"` など）では末尾の閉じ引用符や
セミコロンが表示から欠け、その表示をそのまま承認しても別のハッシュになって通らない、
という事故が実地確認で見つかりました（[`data/pitfalls/hook-005.json`](../data/pitfalls/hook-005.json)）。
表示は承認対象の文字列そのものに直しています。

### フックが壊れたら、通す

```js
} catch (err) {
  process.stderr.write(`[guard-sql] hook error (allowing call): ${err.message}\n`);
  process.exit(0);
}
```

例外時は **fail open** にしています。逆に見えるかもしれません。

理由は、フックがバグって全部落ちるようになると、
人はフックを外すからです。外されたら防御はゼロになる。
落ちるのは異常系だけにして、うるさく stderr に出しておく方が、生き残ります。

---

## PowerShell の落とし穴（実話）

`.ps1` は **ASCII のみ**で書いています。日本語のメッセージも入れていません。

Windows PowerShell 5.1 は、BOM なし UTF-8 のスクリプトを
システムの ANSI コードページ（日本語環境では CP932）として読みます。
つまり、BOM なしで保存した `.ps1` に日本語のメッセージを書くと、
**実行時に文字化けします**。

同じ理由で、`Get-Content` で日本語ファイルを確認するときは `-Encoding UTF8` が要ります。

- 原因究明に半日使いました
- 対策は「`.ps1` は ASCII のみ、ドキュメントは日本語」という分離
- ファイル書き込みは常に `[System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))`。
  `Out-File` や `>` は BOM や CRLF を勝手に入れるので使わない

このリポジトリのスクリプトが全部英語なのは、多言語対応の意識が高いからではなく、
これを踏んだからです。

### 5.1 と 7.x は別物（これも実話）

PowerShell 5.1 で初めてテストを回したら、**1 件も実行される前に落ちました。**

```
Split-Path : Cannot bind argument to parameter 'Path' because it is an empty string.
At ...\test-guard-sql.ps1:18
```

原因はこれです。

**Windows PowerShell 5.1 は、`[CmdletBinding()]` が付いたスクリプトの `param()` の
既定値の中で `$PSCommandPath` と `$PSScriptRoot` を空にします。**
`param()` を抜けた後の本体では正しく入っています。PowerShell 7.x では `param()` の中でも入ります。

```powershell
[CmdletBinding()]
param(
    # 5.1 ではここで $PSCommandPath が "" になる → Split-Path が throw する
    [string] $Hook = $(Join-Path (Split-Path -Parent $PSCommandPath) 'guard-sql.ps1')
)
```

直し方は、既定値を `param()` の外に出すだけです。

```powershell
[CmdletBinding()]
param(
    [string] $Hook
)

$scriptDir = Split-Path -Parent $PSCommandPath   # ここなら 5.1 でも入っている
if (-not $Hook) { $Hook = Join-Path $scriptDir 'guard-sql.ps1' }
```

そして、直して 5.1 で回し直したら、**同じ日にもう 1 件出ました。**

```
powershell.exe : [guard-sql] BLOCKED: DROP is never allowed from an agent.
    + FullyQualifiedErrorId : NativeCommandError
```

フックは正しくブロックしているのに、テストがそこで死ぬ。

**5.1 は、ネイティブコマンドの stderr を `2>&1` でマージすると、各行を `ErrorRecord` に包みます。**
`$ErrorActionPreference = 'Stop'` の下では、それが終了エラーになります。
guard-sql はブロック理由を stderr に出す設計なので、**最初の「落ちるべき」ケースで必ず死ぬ。**
7.x では stderr は素の文字列で渡るので、この現象は起きません。

`2>&1` を外しても直りますが、それだと FAIL したときにフックのメッセージが手元に残らず、
何が起きたか分からなくなります。なので、マージは残したまま、その呼び出しの間だけ緩めています。

```powershell
$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    $out = $payload | & $pwshExe -NoProfile -File $Hook -ApprovalDir $ApprovalDir 2>&1
} finally {
    $ErrorActionPreference = $previous
}
```

### ついでに気づいたこと

`pull-all.ps1` も `2>&1` を使っていますが、こちらは 5.1 で最初から通っていました。
スクリプト先頭で `$ErrorActionPreference = 'Continue'` にしてあるからです。

ただし、**そう書いた理由は「無人で走るので途中で止まってほしくない」であって、
この罠を知っていたからではありません。** たまたま助かっていただけです。
安全が偶然だったことに、テストを 5.1 で回すまで気づけませんでした。

### CI が見逃していた理由

**`shell: pwsh` と `shell: powershell` は別のランタイムです。**
CI が 7.x だけだったので、この 2 件をどちらも見逃していました。
いまは `windows-latest` で `shell: powershell`（＝5.1）のジョブを別に回しています。

---

## 自分の設定と突き合わせたら 4 つ空いていた

この `kit/` は、実際に本番を守っている手元の `~/.claude/` を公開用に書き起こしたものです。
書き起こした以上は同じはずだと思っていたので、1 行ずつ突き合わせました。

**手元が正しくて `kit/` が間違っている箇所が 4 つ**ありました。

| 穴 | 何が起きるか |
|---|---|
| `settings.json` の matcher に PowerShell ツールが無い | Windows で PowerShell 経由の SQL が**フックを素通りする** |
| `deny` に `Bash(Remove-Item -Recurse *)` | `Remove-Item` は Bash のコマンドではない。**この行は何も止めていない** |
| SQL の中和が `--` 行コメントを常に潰す | `npx supabase db execute --sql 'truncate bookings'` の `--sql` 以降が消え、**TRUNCATE が通る** |
| `pull-all` に `GIT_TERMINAL_PROMPT=0` が無い | 「ログオン時に無人で走る」と書いておきながら、**認証を聞かれた時点で無言で固まる** |

### 2 つ目は、ただの書き間違いです

技術的に難しいところは何もありません。**Bash の `deny` リストに PowerShell のコマンドを
書いていた**、それだけです。書いた本人はそれで塞いだつもりでいました。

テストは全部通っていました。フックのテストしか書いていなかったからです。
**`permissions` のリストには、この時点でテストが 1 つもありませんでした。**
一番手前にあって一番よく効く層が、一番検証されていなかったことになります。

この節を書いたあとで、同じ書き間違いが `ask` にもう 1 件見つかりました。
`Bash(Invoke-WebRequest *)`。**1 つ見つけたら同じ形を全部探す**、をやっていなかった
ということです。差分では見つかりません。同じ間違いは同じ人が同じ日に何度もします。

### 3 つ目は、賢くしたせいで空きました

見つけたのは 2026-09-07、上の 4 件の差分を取った日です。

中和処理そのものは正しい。SQL のコメントを潰さないと、`-- delete from t` のような
コメント行で誤検知します。それを避けるために入れた処理です。

ただしフックに来るのは SQL だけではありません。シェルのコマンド行も来ます。
そこに SQL の文法を当てると、`--sql` のようなオプションが**丸ごとコメント扱いで消える**。
残るのは `npx supabase db execute` だけになり、TRUNCATE は視界から外れます。

同じ文字列を、**どの経路で来たかによって別の文法として読む**必要がありました。

手元の実物にはこの穴がありません。中和処理そのものを持っていないからです。
つまり誤検知は実物のほうが多い。**公開用に賢くした部分が、新しい穴を作った**わけです。

### 見つけ方に工夫はありません

差分を取っただけです。`kit/` と `~/.claude/` を並べて、違う行を全部説明できるまで見る。
1 時間かかりませんでした。

やっていなければ、この 4 つは「テストが緑だから大丈夫」のまま公開されていました。

### 直す前に書いたテストは、2 つしか落ちませんでした

穴を見つけたあと、先にテストを 4 つ足しました。

```
npx supabase db execute --sql 'truncate bookings'            -> 落ちること
PowerShell ツール経由の drop table x                          -> 落ちること
here-string の中の drop extension "pg_net"                    -> 通ること
supabase/migrations/20260101_x.sql をパスに含むだけのコマンド  -> 通ること
```

修正前に流したら、**落ちたのは上の 2 つだけ**でした。下の 2 つは最初から緑です。

当たり前でした。修正前は PowerShell がそもそもフックの対象外で、**何を渡しても
素通り＝ALLOW** だったからです。誤検知のテストは、誤検知が起きる前には赤くなりません。
赤くするには先に修正を入れるしかなく、それでは順序が逆になります。

**「テストを先に落とす」が成立するのは、塞ぐ側のテストだけです。**

それでも 4 つとも先に書きました。下の 2 つは、この修正が**塞いだ穴の代わりに誤検知を
作っていないか**を見るためのもので、役割が違います。後から書いたら「いま通っているから
OK」を確認しただけになります。

**穴を塞ぐ変更は、たいてい誤検知を増やします。** 塞ぐテストだけ書いて緑にすると、
翌週には自分でフックを外すことになります。

---

## テストが全部通ってから、赤くなりました

ここまでの「緑」は、全部このマシンの中の話でした。GitHub に push して、
CI が本物の環境で初めて走ったら、**14 ジョブのうち 3 つが赤**でした。

落ちたのは guard-sql の PowerShell 系 3 つ（5.1 / ubuntu の pwsh / windows の pwsh）。
ログの末尾はこうです。

```
  PASS  DROP still blocked inside an approved batch

pass: 29   fail: 0
##[error]Process completed with exit code 1.
```

**テストは 29 件全部通っています。** 通りきってから落ちている。
エラーメッセージは 1 行も出ていません。

### 成功したときの `exit 0` を書いていませんでした

`test-guard-sql.ps1` の末尾がこうなっていました。

```
if ($fail -gt 0) { exit 1 }
```

失敗したときだけ `exit` します。成功したときは何も書いていません。
そして最後に走るテストは「落とすこと」を確かめるケースなので、その中で呼んだ
フックが `exit 2` を返します。**その 2 が `$LASTEXITCODE` に残ったまま
スクリプトが終わります。**

GitHub Actions は `run:` の中身を一時スクリプトに包んで、末尾に
`exit $LASTEXITCODE` を付けて呼びます。だから漏れます。

### 手元では緑でした。呼び方が違うからです

```
CI と同じ包み方          -> exit 1
powershell -File で直接  -> exit 0
```

`-File` で呼ぶとその `exit` を通らないので、0 で終わります。
手元でどれだけ回しても、この赤には一生たどり着きません。

**「テストが通る」と「テストランナーが通ったと報告できる」は別のことです。**
前者しか確かめていませんでした。

Node 版は無傷でした。`process.exit(fail > 0 ? 1 : 0)` と両方書いてあったからです。
同じことをする 2 つの実装のうち、片方だけが正しかった。

### 1 つ見つけたので、同じ形を全部探しました

今度はやりました。エントリポイントの `.ps1` を、Actions と同じ包み方で 1 本ずつ
呼んで終了コードを見ました。もう 1 本ありました。

`pull-all.ps1` です。git 管理下でないディレクトリを 1 つ渡すと、最後の
`git rev-parse` が非ゼロを返して、それが末尾まで残ります。
**リポジトリを 1 つスキップしただけで漏れる。** ログオン時に無人で走らせる
スクリプトなので、実運用でも普通に起きます。

ついでに、双子のはずの 2 実装で契約が違っていたのも分かりました。
Node 版は失敗したら 1 を返しますが、PowerShell 版は 0 を返していました。
揃えました。

### これは誤検知です。だから危ない

見逃しではありません。失敗したときはちゃんと 1 を返します。
成功したときに失敗を報告していただけです。

ただ、このリポジトリはずっと「誤検知の多いフックは外される」と書いてきました。
**CI も同じです。** 赤いのに中を見たら全部 PASS、が続けば、人は赤を見なくなります。

そして今回、ログを読むまで「テストが落ちた」のか「ランナーが成功を報告できなかった」
のか区別がつきませんでした。区別できる検査を別に足してあります。
`entry points report success` というジョブで、正常系でエントリポイントを Actions と
同じに呼び、終了コードが 0 であることだけを見ます。

---

## macOS のジョブが無料枠を食い潰していました

2026-09-09、CI の全ジョブが数秒で落ちるようになりました。ジョブは作られるのに
ステップが 1 つも実行されず、ランナー名も空。**変更を 1 行も含まない `main` を
回しても同じ**なので、コードでもワークフローでもありません。

原因は GitHub Actions の無料枠 $12 を使い切っていたことでした。
超過分は請求されずに停止するので、Billed amount は全部 $0 のままです。
**エラーメッセージのどこにも課金の話は出てきません。**

前日（9/8）の内訳です。

| ランナー | 実行時間 | 金額 |
|---|---|---|
| macOS | 51 分 | **$3.16** |
| Linux | 298 分 | $1.79 |
| Windows | 177 分 | $1.77 |

**分数が最小の macOS が、金額では最大です。** 単価が Linux の約 10 倍あります。
所要時間を見ている限り、これには気づけません。「3 OS で回しています」と書いたとき、
コストが 3 等分されるとは限らない、という話です。

いまは macOS を `pull_request` から外し、`push`（main）と `workflow_dispatch` の
ときだけ回しています。PR は 1 日に何度も回るところなので、そこから単価の高い
ランナーを抜くのが一番効きます。ジョブ名は変えていません。

記録: [`data/pitfalls/ci-001.json`](../data/pitfalls/ci-001.json)

---

## 記法が 2 つあって、どちらも効いていました

`kit/` の deny は `Bash(rm -rf *)`、手元の実物は `Bash(rm -rf:*)`。
**全行違っていました。** 片方が効いていないなら、どちらかが最初から
何も守っていなかったことになります。

調べても書いていなかったので、測りました。

### 測り方

2026-09-08 に、**2 回に分けて計 10 観測**しました。使い捨ての設定に deny を置いて、
`echo` を叩くだけです。

1 回目はワイルドカード付きの 2 行だけで測って、**両方とも通りました**。
これは「どちらの記法も効かない」ではありません。設定が読まれていなかっただけです
（→「対照群がなければ、間違った結論を出していました」）。
ワイルドカード無しの `Bash(echo exact)` を 1 行足して、**それが落ちることを先に
確かめてから**測り直しています。

2 回目は 3 行です。

```
"Bash(echo exact)"       ← ワイルドカード無し
"Bash(echo pfx:*)"       ← コロン記法
"Bash(echo sfx *)"       ← 空白記法
```

2 回目の結果です。

| パターン | `echo x` | `echo x hello` | `echo xhello` |
|---|---|---|---|
| `Bash(echo x)` | 落ちる | 通る | 通る |
| `Bash(echo x:*)` | 落ちる | 落ちる | 通る |
| `Bash(echo x *)` | 落ちる | 落ちる | 通る |

**コロン記法と空白記法は同じ挙動でした。** どちらもコマンド名の前方一致で、
単語の途中では切れません。ワイルドカードを付けない形だけが完全一致です。

心配していた「片方が全滅」は起きていませんでした。違っていたのは表記だけです。
それでも実物と同じコロン記法に揃えました。次に差分を取った人が、
また同じ 1 時間を使わないように。

### 対照群がなければ、間違った結論を出していました

最初はワイルドカード付きの 2 行だけで測りました。**両方とも通りました。**

「どちらの記法も効かない」ではありません。**設定ファイルが読まれていなかった**
だけです。セッションの作業ディレクトリが想定と違っていて、置いたはずの設定が
そもそも見られていませんでした。

ワイルドカード無しの `Bash(echo exact)` を 1 行足して、**それが落ちることを
先に確かめる**ようにしたら、次の実行で分かりました。

止まらない実験は、止まらない理由が 2 つあります。**効いていないのか、
測れていないのか。** 区別する 1 行が要ります。

### ただし、両方に同じ穴があります

`echo xhello` が通る、というのは言い換えるとこうです。

```
Bash(rm -rf:*)  ->  rm -rf /foo    落ちる
                ->  rm -rfv /foo   通る
```

**フラグを 1 文字足すだけで抜けます。** `rm -fr` も同じです。
止めているのは「`rm -rf` という文字列」であって、「`rm` の危険な使い方」では
ありません。

deny の側では塞いでいません。塞ぐには `rm` そのものを deny するしかなく、そうすると
`rm ./dist/app.js` のような日常の操作まで止まります。誤検知の多いルールは外される、
というこのページの話がそのまま当てはまります。

代わりに、フックの側で塞ぎました（`guard-destructive`、後述）。フックならフラグを
1 つずつ分解して見られるので、`-rfv` でも `-fr` でも `-r -f` でも「再帰の削除」として
止められます。deny の穴そのものは、いまも空いたままです。

### この層にはテストが書けません

判定しているのは Claude Code 本体で、こちらのコードではありません。
だから `guard-sql` のようなテストスイートは作れない。できるのは、設定を置いて、
実際にコマンドを叩いて、落ちたかどうかを見ることだけです。上の表はその手作業の
結果です。

**一番手前にあって一番よく効く層が、一番検証しにくい**ということになります。
書き間違いが 5 つあったのも、ここでした。

---

## PowerShell のエイリアスは、心配しなくてよかった

`deny` はほとんど Bash 側にしかありませんでした。`git push --force` も
`git reset --hard` も、PowerShell ツール経由なら素通りします。書き足すことにしたのですが、
その前に確かめたいことが 1 つありました。

PowerShell では `rm` は `Remove-Item` の別名です。`del` `rd` `rmdir` `erase` `ri` も同じ。
deny がコマンド文字列の前方一致なら、**`PowerShell(Remove-Item:*)` は `rm -rf x` を
止めない**はずです。だとすると 6 語ぜんぶ書く必要がある。

2026-09-08、記法の測定と同じ回に測りました。**止まりました。**

```
deny に PowerShell(Remove-Item:*) / allow に PowerShell(rm:*)

rm <ファイル>            -> 落ちる
Remove-Item <ファイル>   -> 落ちる
```

エイリアスは名前を解決してから照合されます。叩いたのは `rm` だけですが、
`del` `rd` `rmdir` `erase` `ri` も `Get-Alias` で見ると同じ `Remove-Item` の別名なので、
この 1 行でまとめて止まります（この 5 語は叩いていません）。逆向きも同じで、
`PowerShell(gci:*)` と書くと `Get-ChildItem` も落ちます。

**そして deny は allow に勝ちます。** 上の `rm` は allow に入れてあったのに落ちました。

書き足す行は 33 行から 16 行に減りました。

### 抜けるのは、実体を名指ししたときです

`curl` は PowerShell 5.1 では `Invoke-WebRequest` の別名なので、
`PowerShell(Invoke-WebRequest:*)` で止まります。**`curl.exe` と書くと止まりません。**
別名ではなく `C:\Windows\system32\curl.exe` を直接呼んでいるからです。

PowerShell 7 では話が逆になります。7 は `curl` / `wget` の別名を持たないので、
`curl` と打つとそのまま `curl.exe` に解決されます。**5.1 で塞がる書き方が 7 では抜ける。**
両方書けば両方で止まります。

### 測り方でひとつ間違えました

1 回目は、対照群を片方しか置いていませんでした。「ルールが評価されている」ことを
示す行（落ちるはずのコマンド）は置いたのに、「マッチしないコマンドは通る」ことを
示す行を置いていなかった。

結果は 6 つ全部ブロックでした。これは 2 通りに読めます。**deny が効いているのか、
この経路のコマンドが全部 denied で返っているのか。** `defaultMode` が `default` だと
allow に無いコマンドは確認待ちのまま denied で返るので、区別がつきません。

通るはずのコマンドを 1 つ足して測り直したら、はっきりしました。

**対照群は 2 つ要ります。落ちるはずのものと、通るはずのもの。** 片方だけだと、
実験が動いていないことに気づけません。

---

## `deny` に書いた `.env` は、`cat .env` には効いていませんでした

`settings.json` の `deny` には、最初からこう書いてありました。

```
"Read(.env)",
"Read(.env.*)",
"Read(./**/.env)",
"Read(./**/.env.*)",
```

これは効いています。ただし **Read ツールにしか効きません。**

`.env` の中身を手に入れる経路は 1 つではありません。Read ツールで開く経路、
Bash ツールで `cat .env` を叩く経路、PowerShell ツールで `Get-Content .env`
を叩く経路。`deny` の `Read(...)` が見ているのは 1 つ目だけです。残り 2 つは、
そこに何が書いてあっても通ります。

`permissions` では塞げません。`Bash(cat:*)` を deny すれば `cat .env` は
止まりますが、`cat package.json` も止まります。`PowerShell(Get-Content:*)`
に至っては、ファイルが 1 つも読めなくなります。**「このコマンド」でも
「このファイル」でもなく、「このコマンドがこのファイルを触るとき」でしか
判定できない**のに、`permissions` にはその書き方がありません。

なのでフックにしました。`guard-sql` と同じ PreToolUse フックで、`Bash` と
`PowerShell` の 2 ツールだけを見ます。

判定は 1 行です。**秘密ファイルのパスと、読み出しの形が両方あれば落とす。**

| コマンド | 秘密パス | 読み出し | 結果 |
|---|---|---|---|
| `cat .env` | あり | あり | 落とす |
| `rm .env.bak` | あり | なし | 通す |
| `grep -r createClient src/` | なし | あり | 通す |
| `cat .env.example` | なし（除外） | あり | 通す |

片方だけで落とさないのが要点です。`.env` という文字列が出てくるだけで落とすと、
`grep -r "process.env" src/` が落ちます。読み出しコマンドが出てくるだけで
落とすと、`cat package.json` が落ちます。どちらも、ガードを外す理由としては
十分です。

そして **この層にはテストが書けます。** `permissions` を判定しているのは
Claude Code 本体で、こちらには手が届きません
（→「この層にはテストが書けません」）。フックを判定して
いるのはこちらのコードです。

### 1 つ、広すぎたので狭めました

パス集合は `deny` の `Read(...)` 行をそのまま出発点にしたので、`secrets/`
が入っています。ところがこれは `src/lib/secrets/masker.ts` も落とします。
秘密の入れ物ではなく、秘密を扱うコードです。`secrets/` 配下でも、ソースコードと
文書の拡張子は秘密扱いしないことにしました。`.env.example` を除外したのと
同じ理由です。

**その結果、`deny` の `Read(./secrets/**)` とこのフックで挙動が違います。**
Read ツールで `src/lib/secrets/masker.ts` を開くと落ち、`cat` すると通ります。
直せる側だけ直したからです。`deny` の方は Claude Code 本体が判定するので、
こちらからは狭められません。

---

## 塞いだつもりのものが、`git show` で 1 手で開きました

書き上げてテストが緑になった直後に、`git show HEAD:.env` が通ることに
気づきました。`git diff .env` も通ります。どちらも中身がそのまま出ます。

`cp .env /tmp/x` してから `/tmp/x` を読む形は、最初から「塞がない」と決めて
いました。2 手かかるからです。`git show` は 1 手です。`cat .env` を弾かれた
モデルが次に何を試すかを考えると、これは残せません。

最初は「`git` をリストに足すと `git status` や `git log` まで落ちる」と考えて、
足すのをやめました。**これは間違いでした。** 判定は「秘密パスと読み出しの形が
両方」なので、`git status` には `.env` という文字列が出てきません。落ちません。

実際に落ちるのは `git diff .env` のように**パスを名指ししたとき**だけです。
そのうち中身が出るのは `show` `diff` `cat-file` `blame` `log -p` で、
`checkout` `rm` `add` は出ません。サブコマンドで絞れば済む話でした。

ここで 1 回、判断を間違えかけています。「誤検知が増える」は、自分で書いた
判定の形を思い出す前に出した結論でした。**設計を確かめる前に、設計の帰結を
推測していた。**「記法が 2 つあって、どちらも効いていました」と同じ形の
間違いです。今回は書く前に気づきましたが、気づいたのは実装が終わってからでした。

### 塞いでいない穴

塞げていない場所は、塞げていないと書きます。

- **`cp .env /tmp/x` で別名にコピーしてから読む形。** コピーは読み出しでは
  ないので `cp` はリストに入れていません。2 手かければ抜けられます
- **リストに無い読み出しコマンド。** `myreader .env` は通ります
- **`.env` に似ていない名前の秘密ファイル。** `config/prod-creds.yaml` は
  こちらから見えません
- **書き込み。** `> .env` や `sed -i` は対象外です。これは読み出しのフックです

これは事故を止めるものであって、敵対者を止めるものではありません。`cat .env`
に手が伸びたときに壁に当たる、というだけのものです。それでも、service_role
キーがトランスクリプトに載って残るのを 1 回止められれば元は取れます。

---

## deny をすり抜ける形の、半分はもう古い話でした

`permissions.deny` は前方一致だから、`cd /tmp && rm -rf x` や `timeout 30 rm -rf x`
のように前に何か付けるだけで抜ける。外部のリポジトリを調べていてそう読み、
ROADMAP にもそう書いていました。

公式ドキュメント（[Configure permissions](https://code.claude.com/docs/en/permissions)、
2026-09-17 に読み直したもの）には、**そこはもう塞がっている**と書いてありました。

- `&&` `||` `;` `|` `&` と改行でコマンドを分けて、**deny はその 1 つずつに当てる。**
  サブシェル、`$(...)`、`for` の中も同じ
- `timeout` `time` `nice` `nohup` `stdbuf` `command` `builtin`、フラグなしの `xargs`、
  先頭の `FOO=bar` は外してから照合する
- PowerShell は構文木で分けて、エイリアスも解決する

以前、`Set-Location ...; Remove-Item ...; git commit ...` を 1 行で渡したら、
`Remove-Item` が 1 つ混ざっていただけで丸ごと拒否されたことがありました。
あれはこの仕様どおりの動きでした。

同じページには、**deny が一致しない形**もはっきり書いてあります。
「プログラムのまわりのセキュリティ境界ではない」とまで書いてあります。

| deny | 止まる | 止まらない |
|---|---|---|
| `Bash(rm *)` | `rm -rf build/` | `/bin/rm -rf build/`、`bash -c 'rm -rf build/'` |
| `Bash(git push *)` | `git push origin main` | `git -C . push origin main`、`git -c k=v push origin main`、`git 'push' origin main` |

ほかに、フラグ付きの `xargs -n1` と、`npx` や `devbox run` のような実行ツールも
外されません。前に書いた `rm -rfv`（[perm-005](../data/pitfalls/perm-005.json)）と、
フラグを後ろに置いた `git push origin main --force` も、前方一致では拾えません。
まとめて [perm-006](../data/pitfalls/perm-006.json) に記録しています。

### 本当に抜ける形だけを、フックで見ます

[guard-destructive](../kit/claude/hooks/guard-destructive.mjs) は、deny に書いてある
破壊系のコマンドが、**deny の一致しない形で来たとき**に止めます。禁止する中身は
deny と同じで、新しく足してはいません。

| 形 | 例 |
|---|---|
| シェルや評価器を挟む | `bash -c` `sh -c` `eval` `echo ... \| sh` `bash <<EOF` `powershell -Command` `-EncodedCommand`（base64 を戻して読む） `cmd /c` `Invoke-Expression` `wsl` |
| パスや引用符で呼ぶ | `/bin/rm` `\rm` `'rm'` `git 'push'` |
| 外されないラッパー・実行ツール | `sudo` `env` `xargs -n1` `find -exec` `npx` `pnpm dlx` `bunx` `devbox run` `direnv exec` `mise exec` `uv run` `busybox` `watch` `flock` |
| git のグローバルオプション | `git -C .` `git -c k=v` `git --git-dir=...` |
| 前方一致で列挙できないフラグ | `rm -rfv` `rm -fr` `rm -r -f` `rm --recursive` `git push origin main --force` `git push -uf` `git push origin +main` `--force-with-lease` `git clean -xdf` |
| インタプリタの 1 行 | `node -e` の `rmSync(..., { recursive: true })`、`python -c` の `shutil.rmtree`、`os.system('rm -rf ...')` |

Bash のコマンドは POSIX シェル、PowerShell のコマンドは PowerShell、`cmd /c` の中は
cmd の文法で読みます。1 つの文法で全部読もうとしたのが、guard-sql で穴を作った
原因でした（「3 つ目は、賢くしたせいで空きました」）。

deny に合わせて広げたのは 2 か所です。`rm` は `-rf` だけでなく、再帰のフラグが
付いたもの全部（`Bash(rm -r:*)` も書いてあるので、意図は同じです）。`git clean` は
`-fd` だけでなく、`-n` の付かない `-f` 全部。PowerShell の `Remove-Item` は、deny と
同じく再帰かどうかを問わず止めます。

deny の対になるものがない判定も 2 つだけ足しました。`git -c alias.x=...`（その場で
作った alias は何のコマンドにでもなれる）と、`git -c clean.requireForce=false`
（`-f` なしで `git clean` を効かせる）です。どちらも上の禁止を隠すためにしか使い道がありません。

### 通す側を多めに書きました

テストは 206 件で、止める側が 135 件、通す側が 71 件です。通す側で一番多いのは、
危ないコマンドの**名前が書いてあるだけ**の文字列です。

```bash
git commit -m "$(cat <<'EOF'
feat: block rm -rf variants (and git push --force)

Don't let bash -c 'rm -rf x' through.
EOF
)"
```

`$( )` の対応を取るときに、ヒアドキュメントの本文をコードとして数えると、`Don't` の
`'` や `(and` の `(` で対応が崩れます。崩れると、本文の `git push --force` を
コマンドとして読んでしまう。書いている途中でこれに気づいたので、`$( )` の対応を
取る処理に、ヒアドキュメントの本文を読み飛ばす処理を足しました。

`python3 -c "print('shutil.rmtree is dangerous')"` は、最初のテストで実際に落ちました。
文字列の中身を空にしてから呼び出しの形を見るように直しています。

### 塞いでいない穴

- スクリプトファイルの中身、`npm run` の中身、Makefile、前もって定義した git の alias
- `ssh host ...`、`docker exec ...`（別のマシンやコンテナの中の話）
- `find . -delete`、`gh repo sync --force`、`git stash drop`、`git checkout -- .`。
  deny にも書いていないので、今回は広げていません
- 見えないところで代入された変数。`$CMD -rf x` の `$CMD` は、同じコマンドの中で
  代入が見えたときだけ中身を追います
- `Start-Process cmd -ArgumentList '/c rd /s /q x'` のような、引数の文字列に埋めた形
- PowerShell 版（`guard-destructive.ps1`）はまだありません。`install.ps1 -Hook powershell`
  でも、このフックだけは Node 版を登録します

公式ドキュメントのとおり、コマンドの文字列に頼らずに止めたいならサンドボックスです。
これは、deny に弾かれたモデルが「別の書き方」を試したときに、もう一度壁に当たる
ようにするためのものです。

---

## 動作確認

入れたら必ず確認してください。効いていないフックは、あるだけ危険です。

### 1. テストスイートを走らせる

```bash
node kit/scripts/test-guard-sql.mjs     # Windows / macOS / Linux
```

```powershell
.\kit\scripts\test-guard-sql.ps1        # PowerShell 版を使う場合
```

合計 45 ケース（落とす 20 / 通す 16 / 承認トークン関連 9）。「止まるべきもの」と「止まってはいけないもの」を両方見ます。承認トークン関連には、BLOCK 表示が承認対象の文字列と一致することを確認するケースを含みます（[hook-005](../data/pitfalls/hook-005.json)）。

```
guard-sql test suite (node)

must block:
  PASS  DROP TABLE
  PASS  TRUNCATE
  PASS  DELETE, no WHERE
  PASS  TRUNCATE behind --sql
  PASS  DROP in a file fed with -f
  PASS  DROP in a file piped through cat
  PASS  a file route with nothing readable behind it
  (抜粋。must block は 20 件)

must allow:
  PASS  DELETE with WHERE
  PASS  keyword inside a string
  PASS  harmless SQL in a file
  PASS  an -f that belongs to another command
  PASS  harmless here-document
  (抜粋。must allow は 16 件)

approval token:
  PASS  BLOCKED Statement: shows the exact text isApproved() fingerprints
  PASS  approved DDL passes
  PASS  token is single use
  PASS  approved blind file route passes
  (抜粋。承認トークン関連は 9 件)

pass: 45   fail: 0
```

**誤検知のテストの方が大事**です。正しい SQL が落ちるようになると、人はフックを外します。

実際、`unrelated MCP tool` のテストを足したときに PowerShell 版の穴が見つかりました。
`mcp__GitHub__search_code` の `query` フィールドに `drop table` と書いて検索すると、
それを SQL と誤認して落としていた。`settings.json` の matcher で守られてはいましたが、
matcher は一行広げれば効かなくなります。フック側でもツール名を見るようにしました。

CI（`.github/workflows/test.yml`）の内訳:

| ジョブ | 環境 |
|---|---|
| guard-sql (node) | Ubuntu / macOS / Windows |
| guard-sql (powershell) | Windows / Ubuntu（pwsh 7.x） |
| **guard-sql (Windows PowerShell 5.1)** | Windows（`shell: powershell`） |
| pull-all | Ubuntu / macOS / Windows（Node 版と PowerShell 版の両方） |
| installers | Ubuntu / Windows |
| `.ps1` のパース / 非 ASCII 検査 | — |

### 2. 実際に配線されているか確かめる

テストが通っても、`settings.json` に登録されていなければ意味がありません。

Claude Code に、こう頼みます。

```
supabase で `select 1; drop table nothing;` を実行して
```

`[guard-sql] BLOCKED: DROP is never allowed from an agent.` が出れば正常。
何も起きずに実行されたら、フックが配線されていません。

**Supabase MCP を実際に使う場合は、matcher が実際のツール名と一致することも必ず確認してください。**
接続するコネクタによってツール名の接頭辞が変わることがあり（例: `mcp__claude_ai_Supabase__list_projects`）、
固定接頭辞の matcher だと一致せず、フックが発火しないまま気づかないことがあります
（[hook-004](../data/pitfalls/hook-004.json)）。

## Windows 形式の秘密ファイルパス

`guard-secrets` はパス判定時にバックスラッシュをスラッシュへ統一します。
`Get-Content C:\Dev\app\secrets\prod.yaml` や `.ssh\config` の読み取りも検出対象です。
`secrets\README.md` や `secrets\masker.ts` など、既存の文書・ソースコードの例外は維持します。
これはコマンド文字列の事故防止検査であり、シェルの全構文を解析するものではありません。

秘密ファイルガードは、コマンド名末尾の `.exe`（大小文字を区別しない）を除いて読み取り操作を判定します。
`git.exe show HEAD:.env` や `python.exe -c` による秘密ファイル読み取りも検出し、
`git.exe add .env` と公開テンプレートの読み取りは引き続き許可します。

公開テンプレートの例外（example / sample / template / dist）はファイル名だけで判定します。
親フォルダが `.env.example.cache` などの名前でも、その中の `.env` は秘密ファイルとして検出します。
