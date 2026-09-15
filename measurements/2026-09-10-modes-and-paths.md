# 実測 第2回 — 権限モードと deny のパス記法

2026-09-09 作成、**2026-09-15 改訂**（ラウンド4を実物の形に修正、bypass permissions の測定手順を追加）。
1 回のセッション（正しくは 5 回の再起動）で 2 つの未決を片付けるための手順です。

## これで決まること

ROADMAP の 3 項目に答えます。

1. **`kit` の `defaultMode: "ask"` は存在しない値です。** 無効値を書いたとき
   Claude Code が何をするか（起動しない / 黙殺して組み込みの既定に落ちる /
   何かに解釈する）は公式に記載がありません
2. **`disableAutoMode` は「値」だけでなく「置き場所」も kit と実物で違います。**
   `kit` はトップレベルに `true`、実物は `permissions` の中に `"disable"`。
   未知は「値」と「置き場所」の2軸ですが、測るのは実在する2つの形だけです
   （ラウンド3＝kitの形、ラウンド4＝実物の形）
3. **`deny` のパス側グロブ記法。** 素 / `./` / `**/` / `./**/` / `//**/` と、
   サフィックス・プレフィックス・dot 始まりの組み合わせ。第 1 回はルート直下
   までしか帰属できませんでした
4. **bypass permissions がどちらの形で止まるか。** kit にだけある
   `disableBypassPermissionsMode: true`（トップレベル）が効くかどうか。
   実物にはこのキー自体が存在しないため、実物の形（ラウンド4）では測りません

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
- **モードの観測は2経路あります。** A＝対話TUI（本番経路、Shingoさんの手で
  ステータスバーと `Shift+Tab` の循環を見る）／B＝`-p` 非対話（CC単独で実行でき、
  transcript の `auto_mode` レコードと `permissionMode` を機械的に読める）。
  B だけだと「キーが効かない」のか「`-p` では見えないだけ」なのかを切り分けられ
  ないので、bypass の判定は両方使います
- **`~/.claude/projects/<slug>/<session-id>.jsonl` の先頭付近に機械可読の
  `auto_mode` レコードがあります**（`{"type":"auto_mode","bashFirst":...,"bypass":...}`）。
  目視より確実ですが、**auto のときだけ出る可能性がある**ので「レコードが無い＝
  autoでない」とは書けません

---

## 準備

### 0. ラウンド0は実施済みです（再実行不要）

**2026-09-09に別セッションで測定済み**（作業ディレクトリは `C:\Dev\_measure2`。
今回の手順とはフィクスチャの置き場所が違いますが、モードの基準線としてはそのまま使えます）。

- Claude Code **2.1.266**、`defaultMode` も `disableAutoMode` も無い状態
- **循環は4モード**: `auto mode on` → `manual mode on` → `accept edits on` →
  `plan mode on` → 戻る。**`bypass permissions` は循環に出ません**
- transcript の `auto_mode` レコード: `bashFirst:true` / `bashFirstSteer:"strict"` /
  `steerOnly:true` / `bypass:false`
- 経路B（`-p` 非対話）で `claude --permission-mode bypassPermissions` を実行:
  **終了コード0で通り**、子セッションの transcript に
  `"permissionMode":"bypassPermissions"` と `auto_mode` の `"bypass":true` を確認済み
  （フラグが受理されただけでなく実際に適用されている証拠）

**このバージョン・この結果を基準線としてラウンド1〜4を比較します。** バージョンが
変わっていたら（`claude --version` で確認）、ラウンド0からやり直してください。

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

## ラウンド 1 — `defaultMode: "ask"`（無効値）

`permissions` に `"defaultMode": "ask"` **だけ**を戻します。
`disableAutoMode` は消したままにします。

起動し直して、**起動したかどうか**と**モード**を記録します。

- 起動しない / エラーが出る → それが答えです
- 起動して **ラウンド 0 と同じ** → **黙殺されて組み込みの既定に落ちている**
- 起動して **ラウンド 0 と違う** → 何かに解釈されている（何にかを書く）

**この結果はラウンド3・4の読み方を決めるオラクルです。** 無効値が黙殺される
なら「ラウンド3・4で変化が無い＝値が無効」と読め、無効値で起動が止まるなら
「ラウンド3・4が起動した＝値は受理されている」と読めます。**ラウンド1の結果を
見てからラウンド3・4を解釈してください。**

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

## ラウンド 3 — kit の形（`disableAutoMode: true` ＋ `disableBypassPermissionsMode: true`）

`permissions` から `defaultMode` を消し、`allow` / `deny` も測定用の行を消して、
**トップレベル**に次の2行だけを置きます（kit が実際に出している形）。

```json
{
  "disableAutoMode": true,
  "disableBypassPermissionsMode": true
}
```

**2つとも kit がトップレベルに置いているキーなので、同じラウンドに相乗りできます。**
`disableAutoMode` は auto の可否、`disableBypassPermissionsMode` は bypass の可否と
別の観測（片方は循環の中身、片方は起動フラグの成否）なので帰属は混ざりません。

### 3-A. 循環の観測（TUI、`disableAutoMode` の判定）

起動し直して、**モード**と **`Shift+Tab` の循環**を記録します。
**`auto` が循環から消えているか**が見るところです。

### 3-B. bypass の観測（`disableBypassPermissionsMode` の判定）

**経路B（`-p` 非対話、機械可読）:**

```
claude --permission-mode bypassPermissions -p "echo ok"
```

- ラウンド0では終了コード0・transcriptに`"permissionMode":"bypassPermissions"`と
  `auto_mode`の`"bypass":true`があることを確認済みです（基準線＝通る）
- **このラウンドで拒否される（非ゼロ終了、または`permissionMode`がbypassPermissions
  になっていない）なら、`disableBypassPermissionsMode: true` は効いています**
- ラウンド0と同じく通るなら、**このキーは効いていない**（か、`-p`経路では見えない
  だけの可能性が残ります。可能なら経路Aでも一度確認してください）

**経路A（対話TUI、任意）:** `/permission-mode` やそれに類する操作で bypass に
入ろうとして拒否されるかを見ます。手が空いていれば行いますが、経路Bだけでも
「効く／効かない」の一次判定はできます。

---

## ラウンド 4 — 実物の形（`permissions.disableAutoMode: "disable"`）

`permissions` を次のようにします。**`disableAutoMode` は実物と同じく
`permissions` の中に置き、値は `"disable"` です。** `disableBypassPermissionsMode`
は**置きません**（実物にこのキー自体が存在しないため。2026-09-09の実測で
`permissions` 直下は allow / deny / ask / defaultMode / disableAutoMode /
additionalDirectories の6キーのみと確認済みです）。

```json
{
  "permissions": {
    "disableAutoMode": "disable"
  }
}
```

**トップレベルには何も置きません。** ラウンド3との違いは「置き場所」と「値」の
両方です — トップレベル+`true`（ラウンド3・kitの形） vs `permissions`の中+`"disable"`
（ラウンド4・実物の形）。

### 4-A. 循環の観測

起動し直して、**モード**と **`Shift+Tab` の循環**を記録します。

- ラウンド 3 と 4 で **循環が同じ**（どちらも auto が消える、またはどちらも
  消えない）→ 置き場所によらずどちらの形でも効く（か、どちらも効かない。
  ラウンド 0 の循環と比べて判定してください）
- **違う** → 効く方が正しい置き場所・値です。ラウンド3（kitの形）が効かない側
  なら、**公開予定の kit は auto を止められていない**ことになります

### 4-B. bypass の観測（対照としてもう一度）

`disableBypassPermissionsMode` を置いていないこのラウンドで
`claude --permission-mode bypassPermissions -p "echo ok"` を実行し、
**ラウンド0と同じく通ることを確認します。** これは「キー無し」の2回目の観測に
すぎず、bypass軸の帰属はラウンド0とラウンド3の対比だけで成立します
（このラウンドで通らなかった場合は、別の要因が混ざっているので先に切り分けて
ください）。

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
