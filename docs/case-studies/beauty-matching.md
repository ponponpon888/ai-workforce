# 事例: 美容領域のマッチングプラットフォーム

契約上の理由により、サービス名を伏せています。業種の粒度も落としています。

> **引用コードの匿名化について**
> このプロジェクトはテーブル名・列名・UI 文言に業種が特定できる語が入っているため、
> 引用時に一般名へ置換しています。**構造は変えていません。**
> 名前を伏せることと、中身を薄めることは別なので、設計判断と踏んだ穴はそのまま書きます。

| | |
|---|---|
| 形態 | 二面市場のマッチングプラットフォーム（施術者 × 施設の空き枠） |
| 構成 | Next.js App Router / Supabase / Vercel / Resend / Anthropic Claude API |
| 開発体制 | 1 人 + AI（技術は私、表に立つのは業界当事者の共同創業者） |
| 開発期間 | 2026-06-02 〜（約 3 ヶ月） |
| 規模 | 300 コミット超・API ルート 20 本超・マイグレーション 50 本超・掲載数十件 |

---

## 「マッチング」を意図的に捨てた

二面市場の話として、ここが一番面白い部分だと思います。

当初は、公開されている施設詳細ページから施術者が自分で見学を申し込めました。
ログインしていれば運営の関与なしに申込が起票され、承認するとチャットルームが開く。
いわゆる普通のマッチングプラットフォームです。

**それを封印しました。** いまの申込経路は 1 本だけで、
**運営が URL を発行しないと到達できません。**

```ts
// /visit/[token]?facility=<slug> — 施設見学申込ページ(登録施術者専用)
// 外部フォームを廃止しDBに一本化するための入口。
// 共同創業者がこのURLを見学希望者に送る。トークンで本人特定、施設はクエリで固定。
```

封印の記録も残してあります。

> 見学申込が **2系統** 並存していた。旧の入口は公開施設詳細ページからリンクされたままで、
> 施術者がログインしていれば**運営の関与なしに申込を起票でき、承認するとチャットルームが開く**状態だった。

自動マッチングのアルゴリズムは存在しません。**人力仲介です。**
プロダクトとしては後退に見えますが、二面市場の初期に「誰と誰を会わせるか」を
アルゴリズムに渡すと、双方の期待値が合わないまま面談が発生します。そこは人間が持つ。

---

## 供給側を 12 マイグレーションぶん先に作った

どちらの側から埋めるか、という問いへの実際の答えです。

| # | 日付 | 内容 | どちら側 |
|---|---|---|---|
| 1 | 06-10 | 初回 5 テーブル | 器は両方、実働は店舗のみ |
| 2〜8 | 06-10〜06-12 | 掲載応募・応募ワークフロー・ライフサイクル・オンボーディング・公開読み取り | **貸し手（店舗）** |
| 9 | 06-16 | 問い合わせ | 借り手 → 貸し手 |
| **12** | **06-22** | **施術者登録** | **借り手（12 本目でようやく）** |

施術者側のテーブル自体は #1 から存在しましたが、台帳に「器だけ・Phase 1 未使用」と
書いてあります。**供給を 12 本ぶん固めてから需要に着手した**という順序です。

---

## 状態機械には遷移表がない

ここは失敗として書きます。

ステータスの型はあります。

```ts
type InquiryStatus =
  | "new" | "replied" | "in_progress" | "matched" | "declined" | "spam";

const STATUS_ORDER: InquiryStatus[] = [
  "new", "replied", "in_progress", "matched", "declined", "spam",
];
```

**`STATUS_ORDER` は表示順の配列であって、許可遷移の定義ではありません。**
管理画面は 6 状態すべてをボタンで並べ、現在値と同じもの以外は全部押せます。

```tsx
{STATUS_ORDER.map((s) => (
  <button key={s} disabled={saving || s === inq.status} onClick={() => onStatusChange(s)}>
    {STATUS_LABEL[s]}
  </button>
))}
```

DB 側も CHECK 制約で**値の集合**を縛るだけです。

```sql
status text not null default 'new'
  check (status in ('new','replied','in_progress','matched','declined','spam')),
```

つまり `matched` → `new` も `spam` → `matched` も通ります。
**状態機械は人間の頭の中と、UI のボタンの並び順にしか存在しません。**

### 契約は status ではなく、nullable な日付列にした

「見学 → 契約 → 利用開始」は `status` とは**別の軸**として実装しています。
この判断は台帳に理由まで残っています。

> 契約は新テーブルを作らず `inquiries` の列にした。理由:
> - 確定見学日・利用開始日と同じ 1 本のタイムライン上の 1 点であり、1 案件 1 契約で多重度が無い
> - `status` に `'contracted'` は足さない。`status` は対応状況のファネル
>   （未対応→対応中→matched…）であって、`matched` と意味が競合する

| 列 | 意味 |
|---|---|
| `contracted_on` | 契約日。null = 未契約。**この列が契約済み判定の唯一の根拠** |
| `contract_type` | monthly / daily / hourly / commission / other（CHECK） |
| `contract_marked_by` | 誰が契約済みにしたか |
| `contract_marked_at` | いつ |

---

## 人間が決める / 機械が刻む

このコードベースで一貫している思想です。

**人間（運営）が決めるもの**: 6 つの status すべて、確定見学日、契約日、利用開始日、
見学日確定メールを送るかどうか、同意書案内を送るかどうか。

```ts
// /admin/inquiries で確定見学日を入れたあと、運営がボタンを押して送る。
// Cron ではない。日程確定の連絡は内容を運営が確認してから送るものなので、
// 日付を入れた瞬間に飛ぶ作りにはしていない。
```

**機械が刻むもの**: 誰がいつ変えたか。ここはクライアントに書かせません。

```
**トリガー trg_set_contract_marked / set_contract_marked()**
- contracted_on が変化したときだけ動く
- null → 日付: contract_marked_by := auth.uid() / contract_marked_at := now()
- 日付 → null: 両方 null に戻す（誤操作を素に戻せる）
- **contract_marked_by / contract_marked_at の書き手はこのトリガーだけ。**
  クライアントから渡された値は上書きされる
```

ステータス変更履歴も同じです。

```sql
create or replace function public.log_inquiry_status()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status then
    insert into public.status_history
      (target_type, target_id, old_status, new_status, changed_by)
    values ('inquiry', new.id, old.status, new.status, auth.uid());
  end if;
  return new;
end; $$;
```

台帳に理由が 1 行で書いてあります。**「アプリ側の書き忘れが構造的に起きない」。**

**唯一の自動遷移**は Cron です。

```ts
//   見学後: inquiries.confirmed_visit_date が「昨日以前」 → 双方へ見学後感想
//   利用後: inquiries.usage_start_date が「3日前以前」   → 双方へ利用後感想
```

管理画面にもそう書いてあります。「契約日は記録のみで、メールは飛びません」。

---

## 冪等性を 4 つ使い分ける

対象の性質ごとに止め方を変えています。

### A. UNIQUE 制約 + `ignoreDuplicates` + `sent_at`（Cron）

```ts
// 冪等性の設計:
//   - feedbacks の UNIQUE(inquiry_id, side, phase) + ignoreDuplicates で行は1回しか作られない
//   - 送信は sent_at IS NULL の行だけ。送信成功で sent_at を記録
//   - よって毎朝何度実行しても、同じ人に同じフォームは二度飛ばない
```

### B. 行ロック + 「どの日付について送ったか」の照合（手動ボタン）

```
**RPC claim_visit_confirm_notify(...) returns jsonb**
- select ... for update で**行ロックを取ってから**判定し、刻んでから payload を返す。
  同時に2回押しても片方しか通らない
- visit_confirm_notified_for が confirmed_visit_date と一致していたら already_sent。
  **見学日が変わればズレるので、もう一度押せる**
```

### C. クールダウン（意図的な再送を許す通知）

同じ手動ボタンでも、**日付に紐づかない**通知は止め方を変えています。

> 案内は特定の日付に紐づかず、相手が無くした等で**意図的な再送があり得る**ため、
> 「同じ日付では送らない」ではなく「10 分以内の連打だけ止める」という線引きにした

### D. 刻んでから payload を返す（承認通知）

```ts
//   - RPC は「status=approved かつ approved_notified_at が null かつ chatルーム有り」のときだけ
//     payload を返し、同時に approved_notified_at を刻む(for update 行ロック)。二重送信は DB 層で不可能。
```

### 弱点も書いておく

- **`status` の遷移そのものには冪等性ガードがありません。** UI が `disabled` にするだけです
- `feedback-dispatch` の `sent_at` 更新は**メール送信の後**です。
  送信成功後・UPDATE 前に落ちると翌朝に再送されます。**at-least-once** です

---

## 送達保証: 1 通も出なかったら刻みを戻す

```ts
// --- 5) 1通も出ていないなら刻みを戻す(押し直せるようにする) ---
if (sent === 0) {
  await admin.rpc("reset_visit_confirm_notify", { p_inquiry_id: inquiryId, p_secret: secret });
  return NextResponse.json({ ok: false, error: "send_failed", failed, skipped }, { status: 502 });
}

// 片方だけ出た場合は刻みを残す(同じ人に二度送るほうが害が大きい)。
// 宛先が無いほうは skipped で返し、画面に出して運営の手動送付に委ねる。
return NextResponse.json({ ok: true, sent, failed, skipped, date: p.visit_date });
```

`sendError` と `throw` の**両方**を拾い、部分成功を `skipped` として画面に返して、
人間の手動送付に引き渡す。トレードオフの判断がコメントに残っているのが大事です。

Cron 側は逆に、宛先そのものが無い場合を別扱いにします。

```ts
if (!to) {
  // 宛先なし: 運営に手動送付を依頼して sent_at を立てる(自動リトライはしない)
  manualNeeded.push(`[${phaseLabel}/${sideLabel}] ... → ${url}`);
  sentIds.push(fb.id);
  continue;
}
```

そして毎朝の運営サマリーで名指しします。**リトライしても永久に届かないものを、
リトライし続けない。** 人間に渡す。

なお、**このサマリーメールの送信失敗だけは意図的に握り潰しています**。
監視の監視は作らない、という割り切りです。

---

## 踏んだ穴

### 冪等キーを「送信処理」に付けていて、「受信者 × 目的」に付けていなかった

旧フローと新フローの Cron が両方 `vercel.json` に**同じ cron 式で**登録されていました。

> 個々のルートは冪等（各自 `sent_at` を持つ）だが、冪等性はルート単位でしか設計されておらず、
> **「2 本のルートが同じ人に同じ目的のメールを送る」ケースはどちらのガードにも引っかからない**。
> データ量が少なかったので偶然発火しなかっただけ。

**冪等キーは処理ではなく、受信者と目的に対して設計すべきでした。**

### Postgres 関数の EXECUTE 権限は 2 系統ある

```
**⚠️ 学び: 関数の EXECUTE は2種類あり、両方 revoke しないと閉じない**

| PUBLIC への既定の EXECUTE            | revoke all on function ... from public |
| anon / authenticated への明示的な EXECUTE | revoke all on function ... from anon, authenticated |

- **#47 は anon, authenticated だけ revoke したので PUBLIC が残った**（#48 で閉じた）
- **#49 は public だけ revoke したので anon / authenticated が残った**（#50 で閉じた）
```

**同じ日に、同じ間違いを逆向きに 2 回やっています。** #47 で片方を忘れ、#48 で直し、
その直後の #49 でもう片方を忘れ、#50 で直す。SECURITY DEFINER の RPC を通知の主要な入口に
している設計では、これは実害に直結します。

### 一度きりのバックフィルを「同期」だと思い込んでいた

多対多テーブルを導入したとき、既存 55 行を `insert ... select` でバックフィルしました。
**新規行に対する仕組みを作らなかった。**

> 以後の同期が無かった。**新規施設には行が出来ず、公開しても status が draft のまま残る穴**

一覧の判定は `facilities.status='published' AND facility_categories.status='published'` の AND なので、
**新規施設は公開しても一覧に出ない**という経路でした。

修正は `AFTER INSERT OR UPDATE OF status ON facilities` のトリガー（`on conflict ... do update` で冪等）。
あわせて設計原則を明文化しています。

> 二重に書ける場所を作らないため。施設管理画面・掲載申込・admin のどれもが
> `facilities.capacity` を書いており、そこに別経路を足すと必ずズレる。

### 未保存のまま「保存済み」と誤認して入力を失う

コミットメッセージがそのまま事例です。

```
fix(zero): 未保存のままアーカイブすると入力内容を失う不具合を修正

handleArchiveToggle() は status / archived_at / updated_by しか UPDATE しない。
にもかかわらず成功後に currentValues で commitBaseline() していたため、
DBへ送っていない title / summary / body を「保存済み」と誤認していた。
未保存表示が消えるので、そのまま画面を離れると入力内容が失われる。
```

### 新規ファイルのコミット漏れ（2 回目）

```
### ★ コミット漏れ再発防止（重大事故記録）
- 2026-06-15: PublishedFacilityCard.tsx が Untracked で本番に無く半日ハマる（過去2回目）
- 教訓: ①push前 git status ②`git add .` 後に new file: 目視
  ③「ローカルは動くのに本番だけ」はまずコミット漏れを疑う
  ④ハマったら仮説より本番の事実（git status/Vercelログ/RPC直叩き）
```

### 業種を見ずにフォームを送っていた

```ts
//   ここが読む FORM_IDS は**特定業種専用**のフォーム4本。
//   横展開の行が inquiries に1件でも入ると、これまでは業種を見ずに
//   専用のフォームを送っていた。気づくのは飛んだ後。
//   そこで vertical を select して、対象外は**処理しない**。
//   代わりに運営サマリーに「未対応の業種があります」として一覧で出す。
//   黙って間違ったフォームを送るより、飛ばさずに気づける形にしてある。
```

---

## マイグレーション: `supabase/migrations/` が存在しない

このリポジトリで一番大きな構造的判断であり、一番の失敗でもあります。

**SQL ファイルは 1 本もコミットされていません。**
代わりに「本番 Supabase に直接適用し、SQL 全文を Markdown 台帳に書き写す」方式です。

台帳の質自体は、正直なところ多くの `supabase/migrations/*.sql` より高いです。
各エントリが「適用日 / Supabase 側の migration name / version / 経緯 / 追加列の表 /
本番での検証結果（期待値と実測値）」を持っています。
コミットも DDL 適用と台帳追記が同一コミットに束ねられています。

**それでも 2 回破綻しました。**

```
### なぜ分割したか

docs/db-schema-phase1.md が **270KB** に達し、**チャット側から書き込めなくなった**ため。
GitHub の contents API はファイル全文をインラインで送る必要があり、270KB は出力上限を超える。
台帳が追記できない状態が続くと、**当てたDDLが記録されないまま溜まる**（実際 11本溜めた）。
```

もう 1 つは採番衝突です。

```
### ⚠️ #45〜#54 の採番について
**#45〜#54 のSQL本文の先頭コメントは、1つ手前の番号（#44〜#53）を自称している。**
実際に適用した時点で #44 が既に取られていたことを見落としたため。
```

同じ日に書かれた 2 つの文書が、同じマイグレーションを別々の番号で呼んでいます。

**教訓ははっきりしています。Markdown 台帳は人間には読みやすいが、
single source of truth にはならない。** 機械可読ではなく、CI で検証できず、
ロールバック単位でもなく、番号衝突が実際に起きました。
真の履歴は Supabase 側にあり、リポジトリはその人力ミラーです。ミラーが 2 回壊れた。

これが [05 本番 DB の取り決め](../05-production-db.md)で
「スキーマの変更は必ずマイグレーションに残す」と書いている理由です。

---

## RLS

個人情報を持つテーブルは、**INSERT ポリシー自体を作らず RPC 一本化**しています。

```sql
alter table public.inquiries enable row level security;

create policy "admin read inquiries"   on public.inquiries for select using (public.is_admin());
create policy "admin update inquiries" on public.inquiries for update using (public.is_admin());

-- 投稿は RPC 経由のみ（anon の直接 insert は不可）
create or replace function public.submit_inquiry(...) returns json
language plpgsql security definer set search_path = public as $$
begin
  ...
  if p_ip_hash is not null then
    select count(*) into v_recent from inquiries
     where ip_hash = p_ip_hash and created_at > now() - interval '1 hour';
    if v_recent >= 5 then
      return json_build_object('ok', true, 'inquiry_id', null);  -- 偽成功
    end if;
  end if;
  ...
end; $$;
```

レート制限超過時に例外ではなく**偽の成功**を返すのは、ボットにフィルタを学習させないためです。
生 IP は保存せずハッシュのみ。

サーバー側でも二重化しています。

```ts
// 認可:
//   呼び出し元のアクセストークンで profiles.role='admin' を確認してから実行する。
//   既存のルートはサーバー側シークレットだけでルート自体は誰でも叩けたので、そこは踏襲していない。
```

### 未処理の宿題（本人申告）

```
- **inquiries の authenticated 権限が最小化されていない。** anon は0件にしたが、
  authenticated には DELETE / TRUNCATE / REFERENCES / TRIGGER が default privileges 由来で残っている。
  RLS が止めているので実害は無いが、基準には合っていない
- **verticals 系 3 テーブルは依然 RLS 有効・ポリシー0本のまま。**
```

「RLS が止めているから実害はない」は正しいのですが、**GRANT の最小化とは別レイヤーの防御**です。
片方に頼っている状態を、宿題として台帳に書いてある。この形は真似する価値があります。
