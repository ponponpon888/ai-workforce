# 02. 機械的な歯止め

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

同時に、`defaultMode` を `ask`、`disableBypassPermissionsMode` を `true`、
トップレベルの `disableAutoMode` を `true` にして、
**「全部承認なしで通すモード」に入れなくしています**。

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
網羅できないことを前提に、層 3 を置いています。

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

## 記法が 2 つあって、どちらも効いていました

`kit/` の deny は `Bash(rm -rf *)`、手元の実物は `Bash(rm -rf:*)`。
**全行違っていました。** 片方が効いていないなら、どちらかが最初から
何も守っていなかったことになります。

調べても書いていなかったので、測りました。

### 測り方

使い捨ての設定に deny を 3 行置いて、`echo` を叩くだけです。

```
"Bash(echo exact)"       ← ワイルドカード無し
"Bash(echo pfx:*)"       ← コロン記法
"Bash(echo sfx *)"       ← 空白記法
```

結果です。

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

塞いでいません。塞ぐには `rm` そのものを deny するしかなく、そうすると
`rm -rf ./dist` のような日常の操作まで止まります。誤検知の多いルールは外される、
というこのページの話がそのまま当てはまります。
いまは、抜け方が分かったうえで残しています。

### この層にはテストが書けません

判定しているのは Claude Code 本体で、こちらのコードではありません。
だから `guard-sql` のようなテストスイートは作れない。できるのは、設定を置いて、
実際にコマンドを叩いて、落ちたかどうかを見ることだけです。上の表はその手作業の
結果です。

**一番手前にあって一番よく効く層が、一番検証しにくい**ということになります。
書き間違いが 5 つあったのも、ここでした。

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

合計 29 ケース（落とす 10 / 通す 13 / 承認トークン 6）。「止まるべきもの」と「止まってはいけないもの」を両方見ます。

```
guard-sql test suite (node)

must block:
  PASS  DROP TABLE
  PASS  DROP after a SELECT
  PASS  TRUNCATE
  PASS  DELETE, no WHERE
  PASS  UPDATE, no WHERE
  PASS  unapproved DDL
  PASS  DELETE via psql
  PASS  WHERE hidden in a comment
  PASS  TRUNCATE behind --sql
  PASS  DROP via the PowerShell tool

must allow:
  PASS  DELETE with WHERE
  PASS  UPDATE with WHERE
  PASS  plain SELECT
  PASS  keyword inside a string
  PASS  DELETE inside a comment
  PASS  semicolon inside a string
  PASS  dollar-quoted body
  PASS  non-SQL Bash
  PASS  Bash rm, not our job
  PASS  unrelated MCP tool
  PASS  empty input
  PASS  here-string written to a file
  PASS  migration path in a command

approval token:
  PASS  approved DDL passes
  PASS  token is single use
  PASS  approval is exact-match only
  PASS  approved multi-statement DDL passes
  PASS  multi-statement token is single use too
  PASS  DROP still blocked inside an approved batch

pass: 29   fail: 0
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
