# Supabase の公開範囲を、自分で数える

公開鍵（anon key）はブラウザに配られます。「公開鍵で何が読めるか」は設計の話ではなく、
数えれば分かる話です。[`kit/supabase/`](../kit/supabase/) に、自分のプロジェクトの SQL Editor に
貼って流す点検を 3 本置きました。

| ファイル | 分かること | 読むもの |
|---|---|---|
| [`exposure-who-can-read.sql`](../kit/supabase/exposure-who-can-read.sql) | 未ログインとログイン済みが、どの表の何列まで読めるか | 権限・ポリシー・列の名前。表の行は読まない |
| [`exposure-count-as-roles.sql`](../kit/supabase/exposure-count-as-roles.sql) | 未ログインと「登録しただけの他人」から、実際に何行読めるか | 行数だけ |
| [`exposure-callable-functions.sql`](../kit/supabase/exposure-callable-functions.sql) | 未ログインとログイン済みが呼べる `SECURITY DEFINER` の関数と、その権限がどちらの系統で付いているか | 関数の名前と権限。関数は呼ばない |

3 本とも 1 文だけで、何も書き換えません。見るのは `public` スキーマです。

---

## 流すのは、自分のプロジェクトだけです

- **他人のプロジェクトには流しません。** 公開鍵が手に入ることと、測ってよいことは別です。
  頼まれて見るときも、持ち主に流してもらって、結果だけを受け取ります。
- 流す前に読んでください。読んでいない SQL は流さない、はここでも同じです。
- 2 本目は、2 つのロールが SELECT を持つ表とビューの全部に `count(*)` をかけます。
  大きい表は時間がかかるので、ファイルの先頭の `skip` に名前を書いて外します。

---

## 結果の読み方

例は、テスト用の小さなデータベース（[`exposure-fixture.sql`](../kit/supabase/test/exposure-fixture.sql)）に
流したときの出力からの抜粋です。どの表も 3 行入っています。

### 1 本目: だれが、どの列まで読めるか

右端の `row_conditions`（そのロールに当たるポリシーの条件）は、ここでは省いています。

```
role          | object       | reads                         | columns | named_like_private
anon          | t_listing    | rows that meet row_conditions | 2 / 4   |
anon          | t_open       | ALL ROWS (RLS is off)         | 3 / 3   | contact_email
authenticated | t_listing    | rows that meet row_conditions | 4 / 4   | contact_email
```

- `ALL ROWS (RLS is off)` は、その表が丸ごと読めるという意味です。
- `columns` は「読める列 / 全部の列」です。`t_listing` は、未ログインには 4 列中 2 列に絞ってあるのに、
  ログイン済みには 4 列とも残っています。これが [rls-004](../data/app-pitfalls/rls-004.json) の形です。
- `named_like_private` は、読める列のうち、**名前が**連絡先やメモに見えるものです。名前からの推測で、
  中身は見ていません。
- RLS が有効で、そのロールに当たるポリシーが 1 つも無い表は、出しません（1 行も返らないため）。

`authenticated` は「ログインしている人」です。運営のことではありません。
だれでも自分でアカウントを作れるプロジェクトでは、だれでも、と同じ意味になります。

### 2 本目: 実際に何行読めるか

```
asked_as      | counted_as    | object            | rows_visible
anon          | anon          | (objects counted) | 7
anon          | anon          | t_listing         | 2
anon          | anon          | t_open            | 3
anon          | anon          | v_definer         | 3
authenticated | authenticated | (objects counted) | 7
...
```

- `(objects counted)` は、そのロールで数えた表とビューの数です。0 行だったものは一覧に出ないので、
  何も出なかったときにも「数えた」ことが分かるように、ロールごとに必ず 1 行出します。
- それ以外の行は、**知らない人が読める行**です。1 つずつ、公開するつもりだったかどうかと突き合わせます。
- 2 つ目のロールは、`sub` に乱数の uuid を入れたログイン済みです。登録はしたが、どのデータの持ち主でも
  ない人にあたります。この人に見える行は、この人のものではありません。
- `counted_as` は、数えている最中に Postgres が答えたロールです。**`asked_as` と違っていたら、
  その結果は捨ててください。** ロールが切り替わっていません。

`v_definer` が 3 行なのは、ビューが作成者の権限で下の表を読むからです。下の表は RLS で 0 行なのに、
ビュー経由では全部読めます。

### 3 本目: 呼べる関数と、権限の系統

```
role | function          | open_by       | to_close
anon | f_explicit_left() | explicit only | revoke execute on function public.f_explicit_left() from anon;
anon | f_public_left()   | PUBLIC only   | revoke execute on function public.f_public_left() from public;
```

関数の `EXECUTE` は 2 系統あります（[rls-002](../data/app-pitfalls/rls-002.json)）。`PUBLIC` への既定と、
`anon` / `authenticated` への明示です。`PUBLIC only` は、`anon` からは revoke してあるのに `PUBLIC` が
残っていて、まだ呼べる状態です。`to_close` に、どの revoke で閉じるかを出します。

呼べること自体は穴ではありません。入口として公開している関数は、ここに出るのが正しい状態です。

---

## なぜ、数えるところまでやるのか

ポリシーを読むだけでは、何行通るかは分かりません。

- 条件が `is_admin()` のポリシーは、対象が全員と書いてあっても、未ログインには 1 行も返しません。
  1 本目だけを見ると「読める表」に見えます。2026-10-06 の確かめ直しでは、ポリシーの数から
  「読める」と数えかけた表が、実際に数えると 0 行でした。
- 逆もあります。未ログインだけを数えて「塞がっている」と書いた翌日に、ログイン済みの側が開いているのが
  見つかりました（[rls-004](../data/app-pitfalls/rls-004.json)）。数えるロールを 1 つ足しただけです。
- 関数で絞っていても、同じ表を直接読めば素通りすることがあります
  （[rls-003](../data/app-pitfalls/rls-003.json)）。これも、数えて見つかりました。

2 本目は、1 つの文の中でロールを切り替えています。切り替えはその文のあいだだけ効き、文が終わると
呼んだ人のロールに戻ります。切り替わらなかったときに気づけるように、数えた側のロールを
`counted_as` に出しています。

---

## 自分のプロジェクトに当てた結果（2026-10-07）

事例の 3 プロジェクトの本番（Postgres 17.6）に流しました。数字は「数えた表とビュー → 1 行でも読めたもの」です。

| プロジェクト | 未ログイン | 登録しただけの他人 | 呼べる関数（未ログイン / ログイン済み） |
|---|---|---|---|
| [MUSUBU](case-studies/musubu.md) | 0 → 0 | 89 → 0 | 0 / 2 |
| [美容領域のマッチングプラットフォーム](case-studies/beauty-matching.md) | 18 → 3 | 24 → 4 | 43 / 64 |
| [Hanami Nail](case-studies/hanami-nail.md) | 2 → 2 | 5 → 2 | 0 / 0 |

- マッチングプラットフォームで読めた 4 つは、どれも公開するつもりの表とビューでした。
- Hanami Nail の「登録しただけの他人」の 2 つのうち 1 つは、公開するつもりのない列まで読めていました
  （[rls-004](../data/app-pitfalls/rls-004.json)）。その日に塞いで、いまは 5 → 1 です。
- トランザクションを開いてロールを手で切り替える数え方（[rls-003](../data/app-pitfalls/rls-003.json) の
  `repro` の方法）とも突き合わせました。比べた範囲では、全部一致しました。

---

## Supabase の Security Advisor との関係

置き換えるものではありません。Advisor を先に見てください。

- **関数**: 3 本目が出した件数は、3 プロジェクトとも Advisor の件数（`SECURITY DEFINER` の関数を
  未ログイン / ログイン済みが実行できる、という 2 つの指摘）と一致しました。3 本目が足すのは、
  どちらの系統で開いているか、だけです。
- **行数**: Advisor は数えません。Hanami Nail の件は、Advisor の同じ日の結果には出ていませんでした
  （出ていたのは「RLS 有効・ポリシーなし」の INFO 9 件だけ）。
- Advisor が出して、こちらが出さないものもあります（RLS 有効・ポリシーなしの表、関数の `search_path` など）。

---

## 見ていないもの

- `public` スキーマだけを見ます。ほかのスキーマを API に公開している場合と、Storage のバケットは見ません。
- 読み取りだけを見ます。INSERT / UPDATE / DELETE は見ません。
- 関数の中身は見ません。呼べることと、呼んで何が起きるかは別です。
- 「登録しただけの他人」は 1 種類です。ある利用者が、別の利用者やテナントの行を読めるかどうかは数えていません。
- だれでも自分でアカウントを作れる設定かどうかは、SQL からは分かりません。
  ダッシュボードの Authentication の設定を見てください。
- コードを読まないと分からない穴は出ません。webhook の再送、状態の遷移、値の行き先などです。
  [`data/app-pitfalls/`](../data/app-pitfalls/) のレコードの大半はこちら側です。
- Supabase の SQL Editor に貼って流した結果は、まだ確かめていません。確かめたのは、`psql` と、
  Supabase の接続ツール経由です。

**何も出なかったことは、安全の証明ではありません。** 上の項目について、流した日に、そうだったというだけです。

---

## テスト

3 本は [`test-supabase-exposure.mjs`](../kit/scripts/test-supabase-exposure.mjs) で、答えの分かっている
データベースに流して確かめています。使い捨ての Postgres が要るので、見つからないときは `skipped` と出して
終わります。CI では `--require-db` を付けて、Postgres が無いときに赤くなるようにしています。

2 本目には、ロールの切り替えを抜いた版を流して、`counted_as` がそれを示すことを確かめるケースがあります。
信用できない結果は、結果のほうからそう言う必要があるためです。

---

## 出た結果を、自分で直しきれないとき

結果とコードを読んで、直す SQL と、当てる前後に数えた結果までを渡す形で見られます。
[README の「導入支援・相談」](../README.md#導入支援相談) からどうぞ。
