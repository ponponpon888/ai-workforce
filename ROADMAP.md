# ロードマップ

このリポジトリで次に何をするか。要望を見て入れ替えます。

**いまの状態**: v0.1 に向けた整備中。guard-sql 29 ケース・guard-secrets 51 ケース・
pull-all 23 ケースが Ubuntu / macOS / Windows の CI で通っています。

---

## v0.1 までに終わらせること

- [x] **`kit/` を手元の実物と突き合わせた。** 4 件、`kit/` 側が間違っていました
      （PowerShell ツールが matcher から漏れ / `deny` の書き間違い / 中和が
      `--sql` を食う / `GIT_TERMINAL_PROMPT` 無し）。
      経緯は [02](docs/02-guardrails.md)。実物側への逆流（DDL 承認トークン、
      中和処理）はまだです
- [x] **Windows PowerShell 5.1 で検証した。** 1 件見つけて直しました
      （`param()` の既定値の中で `$PSCommandPath` が空になる。[02](docs/02-guardrails.md)）。
      CI に `shell: powershell`（＝5.1）のジョブを追加済み
- [ ] `agent-readonly-role.sql` を実際のプロジェクトで実行し、
      末尾の検証 5 項目を全部試す（**まだ一度も実行していません**）
- [ ] インストーラを素の環境（別ユーザーか VM）で実行して、最初から動くか確認
- [ ] 既存の `settings.json` を持っている人向けに、**マージ手順**を書く。
      いまのインストーラは丸ごと置き換えます（`.bak` は取りますが）
- [ ] **アンインストール手順**を書く。`~/.claude/` を書き換えるツールなのに、
      戻し方が書かれていないのは不親切です
- [ ] 「まず `guard-sql` だけ試す」最小手順を書く。全部入れる前に 1 個だけ確かめたい人向け
- [x] **`permissions` のパターン記法を実測で確定した。** コロン記法
      `Bash(git status:*)` と空白記法 `Bash(git status *)` は**挙動が同じ**でした
      （どちらもコマンド名の前方一致、単語の途中では切れない）。`kit/` を
      実物と同じコロン記法に揃えました。結果は [02](docs/02-guardrails.md)
- [x] **`permissions` にテストは書けないと分かった。** 判定しているのは
      Claude Code 本体で、こちらのコードではありません。書けるのは手順と
      測定結果だけなので、[02](docs/02-guardrails.md) に残しました
- [ ] **`deny` のフラグ変種をどうするか決める。** `Bash(rm -rf:*)` は
      `rm -rfv /` を止めません（前方一致が単語の途中で切れないため）。
      `rm` ごと deny すれば止まりますが、`rm -rf ./dist` まで巻き込みます。
      塞ぐか、穴として書いて残すか
- [x] **コミットのメールアドレスを統一した。** `git config` の local / global とも
      `244106608+ponponpon888@users.noreply.github.com` です。ただし
      **初期の 3 コミットには個人アドレスが残っています**。履歴は書き換えません
- [x] **`deny` / `ask` を PowerShell 側にも書き分けた。** deny 7 行・ask 9 行を追加。
      エイリアスは名前解決されてから照合されるので、`PowerShell(Remove-Item:*)` の
      1 行で `rm` `del` `rd` `rmdir` `erase` `ri` が全部止まります
      （実測したのは `rm` です。残る 5 語は `Get-Alias` で同じ `Remove-Item` の
      別名であることを確認しました）。実体名の `curl.exe` だけは別に書きました
- [x] **`.env` をシェル経由で読むのを塞いだ。** `Read(./.env)` は Read ツールに
      しか効かず、`cat .env` も `Get-Content .env` も素通りしていました。
      `permissions` では解けません（`Get-Content` ごと deny すると全ファイル
      読み取りが死ぬ）。`guard-sql` と同じ PreToolUse フックにしました。
      経緯と、塞いでいない穴は [02](docs/02-guardrails.md)
- [ ] `deny` に `Set-Content` を足すなら、エイリアスの `sc` は書かないこと。
      Windows の `sc.exe`（サービス制御）に前方一致で巻き込みます
- [ ] **`deny` の `Read(./secrets/**)` と `guard-secrets` で挙動が違います。**
      `src/lib/secrets/masker.ts` は Read ツールでは落ち、`cat` では通ります。
      フック側だけ狭められるからです。`deny` を狭める書き方が無いので、
      いまは差があることを書いて残しています
- [ ] **CI の `no TODO left in docs` は文字列 `TODO` を全部拾います。**
      docs に `grep -r TODO src/` のような例を書くと赤くなります。マーカー形
      （`TODO:` など）だけ拾うように狭めるか、例に `TODO` を使わないか。
      いまは後者で回避しています
- [ ] **`deny` のパス側グロブ記法を実測する。** 素 / `**/` / `./**/` / `//**/` の
      4 種類が混ざっていますが、どれが効くか測っていません。コマンド側
      （`Bash(x:*)`）は実測済みですが、パス側は手つかずです。再起動と設定の
      戻しが要るので、専用セッションで行います
- [ ] **`Write` / `Edit` が `.pem` `id_rsa` `secrets/` `.ssh/` を 1 行も
      守っていません。** `deny` の `Write` / `Edit` は `.env` 系だけです。
      上の記法の実測が終わってから着手します
- [ ] **`disableAutoMode` の値が `true` か `"disable"` か未確定。** `kit/` では
      `true` にしています
- [ ] 前身リポジトリ `ai-workforce-os` のログ 14 ファイル（ログ 10・
      `.backup` / `.broken` 4）を削除する
- [x] **CI の全ジョブが数秒で落ちた件の原因を確定させた。** GitHub Actions の
      無料枠 $12 の使い切りでした。**分数が最小の macOS が金額では最大**で
      （9/8: macOS 51 分 $3.16 / Linux 298 分 $1.79 / Windows 177 分 $1.77）、
      単価は Linux の約 10 倍。macOS を `pull_request` から外しました。
      経緯は [02](docs/02-guardrails.md)、記録は
      [`data/pitfalls/ci-001.json`](data/pitfalls/ci-001.json)。
      **設定そのものは、Actions が再び動くまで回せていません**
- [x] **散文がまだ無い観測をどう受けるか決めた。** `origin` に 3 つの形を許します
      — `<path>#<anchor>`（散文がある）/ `issue:<番号>`（報告が出所）/ `record`
      （このレコードが初出）。**「散文が先」は 3 行のスタブで満たせてしまう規則**で、
      スタブと本物は機械から区別できません。形式に落ちるくらいなら、散文が無いことを
      レコードに言わせます。無料にはせず、インデックスが `has_prose` を派生させて
      `counts.without_prose` に数えます（[08](docs/08-pitfall-records.md)）
- [ ] **`test-pull-all.mjs` がソース文字列を grep しています。** `GIT_TERMINAL_PROMPT` と
      `GCM_INTERACTIVE` の検査が、ソースにその文字列があることしか見ていません。
      [MUSUBU の事例](docs/case-studies/musubu.md)に「文字列の grep はテストでは
      ありません」と書いておきながら、同じことをこのリポジトリでやっています。
      実挙動（認証を聞かれる状況で、固まらずに失敗すること）は測っていません。
      項目として立てただけで、着手していません
- [ ] **docs が `settings.json` を引用している箇所と実物がズレます。** 今回 1 件
      （[02](docs/02-guardrails.md) の 560 行付近）見つけて直しましたが、機械的な
      チェックがありません。docs は意図的に抜粋もするので、単純な一致チェックは
      壊れます。断言している引用だけ拾う書き方を決めるか、手動確認に留めるか

---

## 10/05 の公開前にやること

Actions の無料枠は 10/01 にリセットされます。枠が戻ったら、macOS を `pull_request`
から外した設定が意図どおり効いているかを確認します
（[02](docs/02-guardrails.md) ／ [`ci-001`](data/pitfalls/ci-001.json)）。

- [ ] **PR で macOS のチェックが 1 本も出ないこと。** `guard-sql (node)` /
      `guard-secrets (node)` / `pull-all never destroys work` の 3 ジョブぶんです
- [ ] **`main` への push では macOS が 3 本出ること。** 外したのは PR だけで、
      main の網は狭めていません。ここまで消えていたら外しすぎです
- [ ] **全ジョブが緑になること。** PR #9 は枠切れ以降、CI が一度も通っていません。
      actionlint は指摘ゼロで通っていますが、それは静的検査の結果であって、
      走らせた結果ではありません

**public にすれば標準ランナーは無料**になるので、この節は公開した時点で役目を
終えます。それまでの間だけの話です。

---

## v0.1 以降

優先度順。

- **実際に落ちている画面を見せる。** テストの `PASS` はテストの証拠であって、
  製品が動いている証拠ではありません。実セッションのログか画面が要ります
- `guard-sql` を MySQL / SQLite に対応
- `pull-all` の shell 版（Node 版はあります）
- 案件別 `CLAUDE.md` テンプレートを増やす（Prisma、Cloudflare Workers など）
- Vercel の穴を塞ぐ（[07](docs/07-github-vercel.md) で空欄のままの部分）。
  MCP のツール単位の絞り込みと、トークンのプロジェクト限定が調べ切れていません
- `docs/` の残りの英訳（00 と 02 は済み）
- **落とし穴のレコードを増やす。** docs を読み直して列挙した候補は 140 件
      （うちアプリ実装側が 38 件）でしたが、`data/pitfalls/` に入っているのは
      **8 件だけ**です。残り 132 件は 1 件も入っていません。形は
      [08](docs/08-pitfall-records.md) で決まっているので、あとは埋める作業です
- **他の人が報告した落とし穴を `data/pitfalls/` に受け入れる。** Issue の
      [pitfall テンプレート](.github/ISSUE_TEMPLATE/pitfall.yml)からレコードに
      落とすまでの動線がまだ書かれていません（旧「`docs/pitfalls/` を作る」項目は
      `data/pitfalls/` に統合しました）。`origin: "issue:<番号>"` が使えるように
      なったので、**docs を先に書かずにレコードだけ足せます**
- **`data/pitfalls.index.json` の `checks` を実際に回す linter。** いま `checks` には
      2 件入っていますが、**それを検査するものがありません**。データの形だけが先に
      あります。`expect: present` / `absent` を見て対象ファイルを検査するだけの
      小さなスクリプトで足りるはずです
- 開発速度の実測（コミット数、PR リードタイム、1 機能あたりの所要時間）を継続公開

---

## やらないこと

- **記事の量産。** SEO のために薄い記事を増やすと、リポジトリの信用が下がる
- **機能追加のための機能追加。** 自分が本番で使っていないものは入れない
- **穴を隠す。** 塞げていない場所は、塞げていないと書き続ける
