# Contributing

English follows the Japanese. 日本語・英語どちらでも構いません。

---

## 歓迎するもの

順番に、価値が高いと思っている順です。

### 1. あなたが踏んだ落とし穴

**これが一番ありがたいです。** 「この構成でこういう事故が起きた」「この設定は効かなかった」。

コードでなくて構いません。Issue に 3 行書いてもらえれば、それだけで価値があります。
このリポジトリの中身は、ほぼ全部そうやって足されたものです。

### 2. 効かない対策の指摘

書いてあることが間違っている、という指摘。

実際、最初は「Supabase 側でロールを分けて `GRANT` を落とせばいい」と書いていました。
効きません（[06](docs/06-supabase-mcp.md)）。こういうのを見つけたら教えてください。
**もっともらしいが効かない対策を置いておくのが、一番まずい状態です。**

### 3. 移植

- `pull-all` の他ランタイムへの移植（Node / PowerShell / POSIX シェルの3つがあります）
- `guard-sql` の MySQL / SQLite の規則への指摘（実際にその DB で運用している人からの誤検知報告が一番ありがたいです）
- 案件別 `CLAUDE.md` のテンプレート（Prisma、Cloudflare Workers など）

### 4. 翻訳

日本語が正本です。英語版は README と `docs/00` `docs/02`（中身の核 2 本）。
残りの `docs/` の英訳は歓迎します。

---

## 歓迎しないもの

- **自分が使っていない機能の追加。** ここは「実際に本番で使っているもの」だけを置く場所です
- **抽象論の追加。** 「設計が大事」ではなく、実際に落ちたコマンドを書いてください
- **穴を隠す変更。** 塞げていない場所は、塞げていないと書き続けます

---

## PR を出す前に

### テストを通す

```bash
node kit/scripts/test-guard-sql.mjs
node kit/scripts/test-pull-all.mjs
node kit/scripts/test-pull-all.mjs --target sh   # pull-all.sh も触ったなら
```

PowerShell 版も触ったなら:

```powershell
.\kit\scripts\test-guard-sql.ps1
node kit/scripts/test-pull-all.mjs --target ps
```

### guard-sql を変えるなら、テストを両方足す

「止まるべきもの」と「**止まってはいけないもの**」の両方です。

後者を忘れると、正しい SQL が落ちるフックになります。そうなると人はフックを外します。

### `.ps1` は ASCII のみ

Windows PowerShell 5.1 は BOM なし UTF-8 のスクリプトをシステムの ANSI コードページとして
読みます。日本語のメッセージを書くと実行時に化けます。
CI が非 ASCII を検出したら落とします。

ドキュメントは日本語で書いてください。スクリプトのメッセージだけ英語です。

### ファイル書き込みは BOM なし UTF-8

```powershell
[System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
```

`Out-File` と `>` は BOM や CRLF を勝手に入れるので使いません。

### 事実には出典を付ける

外部サービスの挙動（フラグ名、権限名、API の要求権限）を書くときは、公式ドキュメントの
URL を添えてください。**確認できなかったことは、推測で埋めずに空欄のままにしてください。**
`docs/07` の末尾に「未確認事項」の節があります。ああいう形で構いません。

---

## Issue の書き方

決まったテンプレートはありますが、埋まっていなくても読みます。
最低限あると助かるのは:

- OS と PowerShell / Node のバージョン
- 使ったコマンドと、出た出力（そのまま貼ってください）
- 期待した動きと、実際の動き

**秘密情報を貼らないでください。** 接続文字列、API キー、顧客データ。
ログを貼るときは一度読み直してください。

---

# Contributing (English)

## What is most welcome

In order of value:

1. **A pitfall you hit yourself.** Three lines in an issue is enough. Almost everything in this
   repository was added that way.
2. **Telling me a mitigation does not work.** This repository once recommended splitting Postgres
   roles to constrain Supabase MCP. It does not work. A plausible-but-useless guardrail is the
   worst state to be in, so corrections are the most valuable PRs.
3. **Ports** — `pull-all` on another runtime (Node, PowerShell and POSIX shell exist),
   corrections to the MySQL/SQLite rules in `guard-sql` from someone who actually runs
   those engines, more per-project `CLAUDE.md` templates.
4. **Translation.** Japanese is canonical; the README and `docs/00` / `docs/02` exist in English.

## What is not welcome

- Features the author does not actually run in production
- Abstract advice. Write the command that actually failed.
- Changes that hide an open hole

## Before opening a PR

```bash
node kit/scripts/test-guard-sql.mjs
node kit/scripts/test-pull-all.mjs
```

If you change `guard-sql`, add tests on **both** sides — what must block, and what must **not**
block. The false-positive side matters more: a guard that fires on correct SQL gets switched off,
and then there is no guard.

`.ps1` files must stay ASCII-only. Windows PowerShell 5.1 reads a BOM-free UTF-8 script as the
system ANSI codepage, so non-ASCII becomes mojibake at runtime. CI enforces this.

When you state how an external service behaves, cite the official documentation. **If you could
not verify something, leave it blank rather than guessing** — see the "未確認事項" section at the
end of `docs/07` for the pattern.

Never paste secrets into an issue. Re-read your logs before posting them.

## License

By contributing you agree your contribution is licensed under the MIT License.
