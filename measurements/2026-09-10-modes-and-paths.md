# 実測 第2回 — 権限モードと deny のパス記法

2026-09-09 作成、未実行。1 回のセッション（正しくは 5 回の再起動）で 2 つの
未決を片付けるための手順です。

## これで決まること

ROADMAP の 3 項目に答えます。

1. **`kit` の `defaultMode: "ask"` は存在しない値です。** 無効値を書いたとき
   Claude Code が何をするか（起動しない / 黙殺して組み込みの既定に落ちる /
   何かに解釈する）は公式に記載がありません
2. **`disableAutoMode` は `true` か `"disable"` か。** 公式のモード表に載って
   いるのは `"disable"` の方だけで、`kit` は `true` を出しています
3. **`deny` のパス側グロブ記法。** 素 / `./` / `**/` / `./**/` / `//**/` と、
   サフィックス・プレフィックス・dot 始まりの組み合わせ。第 1 回はルート直下
   までしか帰属できませんでした

## 測る前に分かっていること

- **設定を再読み込みするコマンドは存在しません。** `settings.json` をディスクで
  編集したら、Claude Code を完全に終了して起動し直すしかありません
- **この環境では、新しいウィンドウで `claude` を起動しても既存セッションが
  再開され、cwd が `C:\Users\kuron` から動きません。** そのため使い捨ての
  プロジェクト設定は読まれず、ユーザー設定（`C:\Users\kuron\.claude\settings.json`）
  を直接触るしかありません
- **対照群は 2 つ要ります。落ちるはずのものと、通るはずのもの。** 片方だけだと
  「ルールが効いていない」と「そもそも測れていない」が区別できません。第 1 回は
  これで 1 度失敗しています
- **「通るはず」は、測るディレクトリごとに要ります。** 第 1 回はルートに 1 個
  置いただけで、サブディレクトリの結果を帰属できませんでした
- `deny` は `allow` に勝ちます。測定中 `allow` に `Read(**)` を入れても、
  測っている deny は壊れません
- **答えは 3 値で記録します。** 落ちた / 通った / **聞かれた**。「聞かれた」は
  deny にマッチしなかった側に数えます

---

## 準備

### 1. バックアップ

```
Copy-Item -LiteralPath C:\Users\kuron\.claude\settings.json -Destination C:\Users\kuron\.claude\settings.json.bak.measure2 -Force
```

**このファイルは最後に手で戻します。** Claude Code からは
`PowerShell(Remove-Item:*)` の deny で消せないので、`.bak` は残ります。

### 2. フィクスチャを作る

ホーム直下に、記法ごとに別名のファイルを置きます。**名前が別なら、落ちた
ときにどの deny 行に当たったかが一意に決まります。** 拒否メッセージは
「どの行に当たったか」を教えてくれません（ファイル単体を指定しても
`File is in a directory that is denied` と出ます）。

拡張子は `.cfg` を使います。`.env` を使うと既存の deny 行が偶然マッチして
切り分けできなくなります。

```
powershell -NoProfile -Command 'Set-Location C:\Users\kuron; New-Item -ItemType Directory -Force -Path zzq-dir, .zzq-dot | Out-Null; "x" | Set-Content -LiteralPath zzq-a.cfg, zzq-b.cfg, zzq-c.cfg, zzq-d.cfg, zzq-e.cfg, zzq-f.cfg, zzq-g.cfg, zzq-h.cfg, zzq-l.cfg, zzq-pass.cfg, .zzq-k.cfg, zzq-dir\zzq-i.cfg, zzq-dir\zzq-pass2.cfg, .zzq-dot\zzq-j.cfg, .zzq-dot\zzq-pass3.cfg'
```

できるもの:

| パス | 役割 |
|---|---|
| `zzq-a.cfg` 〜 `zzq-h.cfg` | 記法 1〜8 の対象 |
| `zzq-l.cfg` | 記法 12（Edit 行のみ）の対象 |
| `zzq-dir\zzq-i.cfg` | 記法 9（`./dir/**`）の対象 |
| `.zzq-dot\zzq-j.cfg` | 記法 10（dot ディレクトリ）の対象 |
| `.zzq-k.cfg` | 記法 11（dot ファイル）の対象 |
| **`zzq-pass.cfg`** | **対照・通るはず（ルート）** |
| **`zzq-dir\zzq-pass2.cfg`** | **対照・通るはず（サブディレクトリ）** |
| **`.zzq-dot\zzq-pass3.cfg`** | **対照・通るはず（dot ディレクトリ）** |

---

## ラウンド 0 — 組み込みの既定を知る

`permissions` から **`defaultMode` の行を消し**、トップレベルの
`disableAutoMode` の行も**消します**。他は触りません。

完全に終了して起動し直し、**ステータスバーの表示**を記録します。

> `⏸ manual mode on`（= `default`）/ `⏵⏵ accept edits on` /
> `⏸ plan mode on` / `⏵⏵ auto mode on` / `⏵⏵ don't ask on` /
> `⏵⏵ bypass permissions on` のどれか

あわせて **`Shift+Tab` を 1 周させて、循環に出てくるモードを全部**書き出します。

これが基準線です。**Pro / Max / Team のターミナルでは組み込みの既定が `auto`**
と公式にあるので、ここが `auto` なら以降の比較がよく効きます。`default` だった
場合は、モード名では差が出ないので**循環の中身**が判定材料になります。

---

## ラウンド 1 — `defaultMode: "ask"`（無効値）

`permissions` に `"defaultMode": "ask"` **だけ**を戻します。
`disableAutoMode` は消したままにします。

起動し直して、**起動したかどうか**と**モード**を記録します。

- 起動しない / エラーが出る → それが答えです
- 起動して **ラウンド 0 と同じ** → **黙殺されて組み込みの既定に落ちている**
- 起動して **ラウンド 0 と違う** → 何かに解釈されている（何にかを書く）

---

## ラウンド 2 — `defaultMode: "default"`（有効値）＋ パス記法

ここが本番です。`permissions` を次のようにします。`disableAutoMode` は
消したままです。

```json
"defaultMode": "default",
"allow": [
  "Read(**)"
],
"deny": [
  "Bash(echo zzqcontrol)",
  "Read(zzq-a.cfg)",
  "Read(./zzq-b.cfg)",
  "Read(**/zzq-c.cfg)",
  "Read(./**/zzq-d.cfg)",
  "Read(//**/zzq-e.cfg)",
  "Read(zzq-f.*)",
  "Read(./zzq-g.*)",
  "Read(**/*-h.cfg)",
  "Read(./zzq-dir/**)",
  "Read(./**/.zzq-dot/*)",
  "Read(//**/.zzq-k.cfg)",
  "Edit(./zzq-l.cfg)"
]
```

**既存の `allow` / `deny` は測定中だけ全部どかします。** 残すと、どの行に
当たったのか分からなくなります。バックアップから戻せます。

`Read(**)` を `allow` に入れるのは、`defaultMode: "default"` のままだと
「deny で落ちた」と「allow に無いだけ」が混ざるからです。deny は allow に
勝つので、測っているものは壊れません。

**`Edit(./zzq-l.cfg)` だけ `Edit(` で書いています。** 第 1 回で「`Edit` の
deny は Write にも効き、Read には漏れない」ことは測れました。今回測りたいのは
**逆向き** — `Read(` しか無い行が Edit / Write を止めるか。実物の
`Read(./secrets/**)` と `Read(//**/.ssh/**)` は Read 行しか無いので、ここが
ROADMAP の答えそのものです。

### 起動し直して、モードを記録

ラウンド 0 と違えば、**有効値は効いている**という対照になります。ラウンド 1 が
ラウンド 0 と同じでラウンド 2 が違うなら、`ask` が黙殺されている証拠です。

### 18 観測

順に試して、**落ちた / 通った / 聞かれた**を記録します。

| # | 何を | 記法 | 期待 |
|---|---|---|---|
| C1 | `echo zzqcontrol` を実行 | コマンド側 | **落ちるはず（対照）** |
| C2 | `zzq-pass.cfg` を Read | deny 行なし | **通るはず（対照・ルート）** |
| C3 | `zzq-dir\zzq-pass2.cfg` を Read | deny 行なし | **通るはず（対照・サブ）** |
| C4 | `.zzq-dot\zzq-pass3.cfg` を Read | deny 行なし | **通るはず（対照・dot）** |
| 1 | `zzq-a.cfg` を Read | 素 | ? |
| 2 | `zzq-b.cfg` を Read | `./` | ? |
| 3 | `zzq-c.cfg` を Read | `**/` | ? |
| 4 | `zzq-d.cfg` を Read | `./**/` | ? |
| 5 | `zzq-e.cfg` を Read | `//**/` | ? |
| 6 | `zzq-f.cfg` を Read | 素 + サフィックス `*` | ? |
| 7 | `zzq-g.cfg` を Read | `./` + サフィックス `*` | ? |
| 8 | `zzq-h.cfg` を Read | `**/` + プレフィックス `*` | ? |
| 9 | `zzq-dir\zzq-i.cfg` を Read | `./dir/**` | ? |
| 10 | `.zzq-dot\zzq-j.cfg` を Read | `./**/` + dot ディレクトリ | ? |
| 11 | `.zzq-k.cfg` を Read | `//**/` + dot ファイル | ? |
| 12a | `zzq-l.cfg` を **Read** | `Edit(` 行しかない | ? |
| 12b | `zzq-l.cfg` を **Edit** | 同上 | ? |
| 12c | `zzq-l.cfg` を **Write** | 同上 | ? |

**C1 が落ちて、C2・C3・C4 が通ること。** これが揃わない測定は無効です。
第 1 回は C3・C4 が無かったので、サブディレクトリの結果を帰属できませんでした。

**dot 始まりを別枠にしている理由**: 守る対象は `.env` と `.ssh/` で、どちらも
先頭がドットです。glob の実装によっては `*` や `**` が dotfile にマッチしません。
非ドットの名前だけで測ると、通っているつもりで通っていない結論になります。

---

## ラウンド 3 — `disableAutoMode: true`

`permissions` から `defaultMode` を消し、`allow` / `deny` も測定用の行を消して、
トップレベルに `"disableAutoMode": true` だけを置きます。

起動し直して、**モード**と **`Shift+Tab` の循環**を記録します。
**`auto` が循環から消えているか**が見るところです。

---

## ラウンド 4 — `disableAutoMode: "disable"`

同じ状態で値だけ `"disable"` に変えます。起動し直して、モードと循環を記録します。

- ラウンド 3 と 4 で**循環が同じ** → どちらの値でも効く（か、どちらも効かない。
  ラウンド 0 の循環と比べて判定）
- **違う** → 効く方が正しい値です。`kit` の `true` が効かない側なら、
  **公開予定の kit は auto を止められていない**ことになります

---

## 復旧

```
Copy-Item -LiteralPath C:\Users\kuron\.claude\settings.json.bak.measure2 -Destination C:\Users\kuron\.claude\settings.json -Force
```

戻したあと**もう一度起動し直して**、いつもの状態に戻っていることを確認します。

フィクスチャ（`zzq-*`、`zzq-dir\`、`.zzq-dot\`）はホームに残ります。
`PowerShell(Remove-Item:*)` の deny があるので Claude Code からは消せません。
**手で消してください。** 9/8 の第 1 回で作った `zzgt-*` と
`C:\Dev\_permtest`、`settings.json.bak-*` 5 つも残っているはずです。

> **ホーム直下で `Remove-Item -Recurse -Force <ワイルドカード>` を書かないこと。**
> Windows PowerShell 5.1 は `-Path` にワイルドカードが付いた `-Recurse` を、
> 親ディレクトリ全体の再帰＋末尾をファイル名フィルタ、として扱います。
> `C:\Users\kuron\zzq-*` のつもりが `C:\Users\kuron` 全体（AppData の
> ジャンクション含む）を走査します。`-LiteralPath` で明示列挙してください。

---

## 記録の書き方

結果はこのファイルの下に追記します。**測った日と、そのときの Claude Code の
バージョン**を必ず書いてください。`permissions` は Claude Code 本体が判定して
いるので、バージョンが変われば結論も変わりえます。落とし穴レコードの
`stale_risk` は、そのバージョンが `"unrecorded"` かどうかで決まります。

書けたら、レコードの `origin` はこのファイルの見出しアンカーに向けられます。
`origin: "record"` を使わずに済む形です。
