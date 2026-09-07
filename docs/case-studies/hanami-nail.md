# 事例: Hanami Nail

訪日客と東京のネイルサロンをつなぐプラットフォーム。

| | |
|---|---|
| URL | https://www.hanaminail.com |
| 構成 | Next.js App Router / Supabase / Vercel / Resend |
| 開発体制 | 1 人 + AI |
| 開始 | 2026-05-02（初コミット）／ Supabase 本番は 2026-05-19 |
| 規模 | 182 コミット・PR 64 本・マイグレーション 42 本・掲載 10 サロン |

英語ファーストのサイトです。言語・予約調整・事前のすり合わせを Hanami 側が引き受けます。
**予約は自動転送せず、Hanami が預かって手で転送する**という設計判断をしています。

---

## RLS は行を守るが、列は守らない

このリポジトリから出た教訓で、いちばん再利用価値が高いのがこれです。

サロン一覧のポリシーはこうなっていました。

```sql
CREATE POLICY "Anyone can view published salons" ON "public"."salons"
  FOR SELECT TO "authenticated", "anon"
  USING (("status" = 'published'::"text"));
```

`status = 'published'` で **行**は絞っています。列は絞っていません。

anon キーはブラウザに配られる公開鍵です。つまり誰でも PostgREST を直接叩けます。

```
GET /rest/v1/salons?select=slug,contact_email,contact_phone
```

**掲載サロンの個人メールアドレスと電話番号が、全件取れる状態でした。**

画面はこれらの列を一切表示していません。だから **UI を見ている限り絶対に気づけません**。

修正は列レベルの GRANT に切り替えることでした
（`supabase/migrations/20260905030000_restrict_anon_salon_columns.sql`）。

```sql
revoke select on table public.salons from anon;

grant select (
  slug, name, area, world, tagline, meta_description,
  hero_image_url, gallery_image_urls, instagram_url, google_maps_url,
  price_range, business_hours, style_tags, english_speaking_staff,
  booking_note, accepts_hanami_inquiry, status
) on table public.salons to anon;
```

マイグレーション内に運用上の注意まで書いてあります。

```sql
-- 新しく anon 側で列を読みたくなったら、ここに列を足す必要がある。
-- 足し忘れると PostgREST が 42501 permission denied を返す（静かに落ちない）。
```

**「静かに落ちない」を選ぶ**のが大事です。列を足し忘れたら 403 で落ちる。
気づかないまま出るより、落ちる方がいい。

---

## 冪等性を 4 通り使い分ける

[00 原則](../00-principles.md)の「先回りして入れるもの」の実例です。
依頼書に「二重送信を防いでください」とは書かれません。

### 1. ユニーク制約を「送信権の予約」に使う

送る**前**に行を立てて、`23505`（unique violation）で重複を検出します
（`app/api/notify/route.ts`）。

```ts
const { error: claimError } = await supabase
  .from("notification_deliveries")
  .insert({ message_id: messageId, channel: "email" });

if (claimError) {
  if (claimError.code === "23505") {
    return NextResponse.json({ ok: true, duplicate: true });
  }
  return NextResponse.json({ ok: false, error: "delivery_claim_failed" }, { status: 503 });
}

try {
  // ... resend.emails.send(...)
  if (sendError) {
    // 送れなかったら予約を取り消して、再試行できるようにする
    await supabase.from("notification_deliveries")
      .delete().eq("message_id", messageId).eq("channel", "email");
    return NextResponse.json({ ok: false, error: "send_failed" }, { status: 502 });
  }
```

### 2. プロバイダ側の冪等キー

```ts
await resend.emails.send(
  { from: FROM, to: TO, subject: adminEmail.subject, /* ... */ },
  { idempotencyKey: `booking-admin/${bookingId}` }
);
```

### 3. 部分ユニークインデックスで「pending は同時に 1 件だけ」

```sql
create unique index if not exists booking_customer_email_attempts_one_pending
  on public.booking_customer_email_attempts (booking_id)
  where status = 'pending';
```

### 4. 「結果が分からない」を状態として持つ

これが一番効いています。

```ts
} catch (error) {
  // 応答を失っただけで、Resend 側は受理している可能性がある。
  // pending のまま残せばリンクは有効で、重複再送も止められる。
  await supabase.from("booking_customer_email_attempts")
    .update({ failure_code: "outcome_unknown" })
    .eq("id", attempt.id).eq("status", "pending");

  return noStoreJson({ ok: false, error: "outcome_unknown" }, 503);
}
```

成功でも失敗でもない第三の状態を作る。これを持たないと、
「タイムアウトしたから再送 → 実は届いていて 2 通」になります。

---

## 送達保証: 失敗を DB に沈ませない

```ts
// 2026-09-05 追加:
//  - 通知が実際に送れたときだけ booking_requests.notified_at を立てる。
//    この API は送信失敗でも 200 を返すので、行に記録がないと
//    「メールが飛ばなかった予約」が誰にも気づかれずにDBに沈む。
//    /admin/bookings がこの列を見て「通知メール未送信」を名指しする。
```

同じ PR で決めたこと。

- **ドライラン時は `notified_at` を立てない**。立てると「送ったことになっているが実は届いていない」が作れる
- **本文は必ずサーバーで組む**。クライアントから本文を受け取ると、
  このエンドポイントが管理者専用の任意メール送信口になる

---

## 機能追加が、既存のゆるい検証を脆弱性に変えた

`/api/booking` の `contact` の検証は「`@` と `.` を含むか」だけでした。
それでも長い間問題ありませんでした。**その値をどこにも送っていなかったからです。**

そこへ「予約受付メールをお客様へ自動送信する」機能が入りました。
`contact` はそのまま `resend.emails.send({ to: contact })` の宛先になります。

**フォームに任意の第三者アドレスを入れれば、公式ドメインから「予約受付メール」を送りつけられる。**
歯止めは同一 IP 5 件/時のレート制限だけ。送信の踏み台としてはドメインのレピュテーションに効きます。

**既存のコードは 1 行も変わっていないのに、脆弱性になった**という例です。
「この値はどこへ行くか」が変わった瞬間に、検証の十分さも変わる。

修正（`lib/contact.ts`）。

```ts
// 方針: 厳密な RFC 準拠は目指さない（厳しすぎると本物の客を弾いて離脱する）。
// 「宛先として成立する形か」と「複数宛先・ヘッダ挿入に使える文字が入っていないか」
// の2点だけを見る。

const EMAIL_PATTERN =
  /^[^\s@,;:<>"'\\()[\]]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/** 制御文字（改行を含む）が入っていないか。ヘッダ挿入の入口を塞ぐ。 */
export function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}
```

---

## 構造化データは素の `<script>` で出す

`next/script` の `<Script>` はクライアント側で挿入されるので、
**SSR された HTML に残りません**。JS を実行しない AI クローラには届かない。

このリポジトリでは、記事ページがサーバーコンポーネントのまま直接出しています。

```tsx
export default function CanTouristsGetNailsPage() {
  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
```

逆に、`next/script` を使っている箇所はこのリポジトリに 1 つだけで、それは GA です。

```tsx
"use client";
import Script from "next/script";
// ...
<Script src={`https://www.googletagmanager.com/gtag/js?id=...`} strategy="afterInteractive" />
```

**「JS を実行しないクローラに届く必要があるものは素の `<script>`、届かなくていい計測タグは `next/script`」**
という使い分けが、コード上で分離しています。

### 忘れたらビルドを落とす

同じ発想の小さな仕掛け（`lib/journal-dates.ts`）。

```ts
// datePublished / dateModified は検索・回答エンジンへの鮮度シグナルなので、
// 記事を増やしたときに忘れられがちな類のもの。
// articleDates() は未登録 slug で throw する: エントリの入れ忘れは
// 「日付なしで静かに公開される」のではなく「ビルドが落ちる」。
export function articleDates(slug: string) {
  const dates = journalDates[slug];
  if (!dates) {
    throw new Error(
      `journal-dates: no dates registered for "${slug}". Add an entry to journalDates in lib/journal-dates.ts.`
    );
  }
```

**静かに劣化するものを、うるさく落ちるものに変える。** これがこのリポジトリ全体の型です。

---

## 認可は 3 層

`app/admin/layout.tsx` のコメントが、そのまま設計書になっています。

```tsx
// admin 配下の共通レイアウト兼ガード（Server Component）。
// この layout を通過した時点で「ログイン済み かつ管理者許可リスト一致」が保証される。
// → admin 配下の各 page は認証チェックを書かなくてよい（認証ロジックの集約）。
//
// 防御は三層になる:
//   1. middleware … 未ログインを /login へ弾く（セッション refresh も担う）
//   2. この layout … 検証済みユーザーをサーバー許可リストで判定
//   3. 管理API / Server Component … service_role をブラウザから隔離
```

admin API の順序も全ルートで一貫しています。

```ts
requireSameOrigin(request);                 // 1. 同一オリジン
body = await readJsonObject(request, MAX);  // 2. 本文サイズ制限
const { user, isAdmin } = await getAdminAuth();
if (!user)    return noStoreJson({ error: "unauthorized" }, 401);  // 3. 認証
if (!isAdmin) return noStoreJson({ error: "forbidden" }, 403);     // 4. 認可
if (!UUID_PATTERN.test(id)) return ... 400;                        // 5. ID 形式
if (!ALLOWED_STATUSES.has(status)) return ... 400;                 // 6. 値のホワイトリスト
```

service_role で RLS をバイパスする箇所では、所有権を**手で**確認します。

```ts
const { data: conversation } = await supabase
  .from("conversations").select("id")
  .eq("id", conversationId)
  .eq("access_token", accessToken)
  .eq("status", "open")
  .gt("token_expires_at", new Date().toISOString())
  .maybeSingle();

if (!conversation) {
  return NextResponse.json({ ok: false, error: "invalid_conversation" }, { status: 401 });
}
```

---

## 踏んだ穴

### スナップショット比較で、使用中の画像が消えるレース

削除対象を「リクエスト冒頭に読んだ値」だけで決めていました。
同じサロンの保存がほぼ同時に走ると（別タブ、二重送信、古い画面からの再送信）：

1. DB が `[A,B,C]` のとき、リクエスト1（C を外す）とリクエスト2（古い状態のまま D を追加＝C 込み）が並行
2. 書き込み順によっては DB は `[A,B,C,D]` になる
3. リクエスト1 は自分のスナップショット比較だけで「C は不要」と判断し `storage.remove([C])`
4. **DB は C を参照したまま、実ファイルが無い**

修正の原則がそのまま使えます。

> - 削除の直前に `salons` を読み直す
> - **読み直しに失敗したら 1 件も消さない**（孤児ファイルが残るのは棚卸しで拾えるが、
>   使用中のファイルを消すと戻せない）

同じ PR で見つかった第 2 の穴も、時間の扱いとして面白い。

> `/api/onboarding/upload` は Storage に置くだけで DB には書かないので、
> **「アップロード済み・まだ保存していない」写真は必ず孤児候補として一覧に出る**。
> 招待リンクは 30 日有効で、サロンが途中離脱して後日戻ってくることがある。
> その間に管理者が良かれと思って隔離 → 7 日後に完全削除、が成立してしまう。

対策は「作成から 72 時間以内、または**作成日時が取れない**オブジェクトは隔離を拒否」。
そして、その数字が推測であることも書いてあります。

> **72時間**: 「サロンが写真を選んで離脱し、翌日〜数日で戻る」を想定した数字で、実測に基づくものではない。

### 「保存されている」と思っていたが、読まれていなかった

オンボーディングの step1〜4 は、下書き行を**一度も読んでいませんでした**。
step1 にはこの行が残っていました。

```ts
const salon = null as SalonRecord | null;
```

step2〜4 には「将来 SECURITY DEFINER RPC を追加して対応する」というコメントだけ。

結果、途中で閉じて同じリンクから戻ると全部入力し直しになり、
そのまま「次へ」を押すと **前の入力が上書きで消えます**。

しかも前日に出した招待メールに「途中で閉じても同じリンクから戻れます」と書いていました。
**コードと、お客さんへの約束が食い違っていた。**

### 業務フローの一部だけがコード化されていて、半公開が起きた

`submit_salon` は status を `draft → pending_review` にするところで終わりで、
**その先（`published` 化）はリポジトリのどこにもありませんでした**。承認も slug の付け直しも
Supabase の SQL Editor で手打ち。

2026-09-04、この手作業のせいで
**「静的LPは公開・DBは `pending_review`・slug は `draft-xxxxxxxx`」という半公開が 4 サロンで発生**、
一覧の見出しにスラッグ文字列が出ていました。

修正で入れた不変条件は、そのままガードレール集として使えます。

- `draft-xxxxxxxx` のままでは公開できない（409）
- LP ページが存在しない slug は、確認なしでは公開できない
  （公開すると `/salons/<slug>` が 404 なのにチャットの推薦には登場する）
- メイン写真がないサロンは公開できない
- **`draft` からの直接公開は認めない**（必須項目検証を飛ばせてしまう）
- **`published` の slug は変更させない**（URL が変わると渡したリンクと sitemap が死ぬ）

### サイレントに 100% 失敗していた削除ボタン

Hero 画像の「削除」は `url: ''` を送る実装でした（NULL 化の意図）。
RPC 側は `NULLIF(TRIM(COALESCE(p_hero_image_url, '')), '')` で正規化済みなのに、
API の手前のガード `isOwnedStorageUrl('')` が false を返すので **100% 弾かれていました**。
画面には `Invalid hero image URL` と出るだけ。

同じ PR で、`app/onboarding/[token]/step4/styles.css` が 3.6KB あるのに
**`import` が 1 つもなく**、その画面だけブラウザ既定の UI で表示されていたことも見つかっています。

---

## 正直に書いておくこと

**このリポジトリの `README.md` は `create-next-app` のテンプレートのままです。**
`CLAUDE.md` の中身も `@AGENTS.md` の 1 行だけで、pitfalls セクションはありません。

[00 原則](../00-principles.md)で「誰が使うかを書いていなかった」を失敗として挙げておきながら、
稼働中のこのリポジトリでも同じことをやっています。ドメイン知識は `HANDOFF.md` と
PR 本文とコード内コメントに散らばっている状態です。

**書いてあることと、やっていることが一致していない箇所を隠さないほうが、たぶん役に立ちます。**

構造化データのカバレッジも一様ではありません。`/journal` 系には JSON-LD がありますが、
`/guides/[slug]` にはありません。共通コンポーネント（`components/JsonLd.tsx` のようなもの）が
無く、各ページが直に書いているのが原因です。
