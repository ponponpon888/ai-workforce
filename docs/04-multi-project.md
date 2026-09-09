# 04. 複数案件を 1 人でまわす

一人で 4〜5 本のリポジトリを持つと、コードを書く時間より
**「どれがどうなっているか思い出す時間」**の方が長くなります。

ここはその時間をゼロに近づけるための話です。

---

## PC を開いた時点で全部最新にする

朝いちばんに `git pull` を忘れて、古い `main` の上に作業を積むのが一番よくある事故でした。
なので、ログオン 1 分後にタスクスケジューラで走らせています。

実物: [kit/scripts/pull-all.mjs](../kit/scripts/pull-all.mjs)（Windows / macOS / Linux）
／ [kit/scripts/pull-all.ps1](../kit/scripts/pull-all.ps1)（PowerShell 版）

### 絶対にやらないこと

このスクリプトが守っているのは、この 4 つです。

- **`stash` しない**
- **`reset` しない**
- **`checkout` しない**
- **`merge` しない**

無人で走るスクリプトが作業ツリーを触ると、いつか必ず作業を消します。
「賢く」する余地はいくらでもありますが、全部やめました。

### 何をするか

| 状態 | 動作 |
|---|---|
| 作業ツリーが汚れている | **スキップ**。何もしない |
| rebase / merge / cherry-pick / revert / sequencer / bisect の途中 | **スキップ** |
| detached HEAD | **スキップ** |
| デフォルトブランチにいて clean | `git pull --ff-only` |
| 作業ブランチにいる | `git fetch origin main:main` |

最後の行が肝です。
`git fetch origin main:main` は、**いま `main` にいなくてもローカルの `main` を進められます**。
チェックアウトを一切動かさないので、作業中のブランチに影響しません。
しかも fast-forward できないときは git が拒否するので、強制されることもない。

作業ブランチで開発しながら、`main` だけは常に最新。これが欲しかった状態でした。

無人で走る以上、git に認証を聞かせるわけにはいきません。スクリプトの先頭で
`GIT_TERMINAL_PROMPT=0` と `GCM_INTERACTIVE=never` を設定しています。
前者はターミナルのプロンプトを、後者は Windows の Git Credential Manager が出す
ウィンドウを止めます。認証の切れたリポジトリは、無言で固まらずに失敗してログに残ります。

### ログ

毎回 `_logs/pull-all_<日時>.log` に残します。30 日で自動削除。

無人スクリプトはログがないと、動いていないことに気づけません。
「今日はスキップした」も含めて全部残します。

### 「壊さない」を証明する

無人で走るスクリプトを信じる根拠は、コードを読んだ印象ではなく、テストであるべきです。

```bash
node kit/scripts/test-pull-all.mjs              # Node 版
node kit/scripts/test-pull-all.mjs --target ps  # PowerShell 版（同じテスト）
```

git をモックしていません。**本物の bare origin と、本物のクローン 6 つ**を作って、
それぞれを別の状態に置いてから、実際にスクリプトを走らせます。

| クローン | 状態 |
|---|---|
| clean-on-main | `main` にいて clean、origin が 1 コミット先 |
| dirty | 未コミットの変更あり |
| feature-branch | 自分のコミットを持つ作業ブランチにいる |
| detached | detached HEAD |
| mid-rebase | **実際に競合させた rebase の途中**で止めてある |
| diverged | ローカル `main` に origin にないコミットがある |

そして走らせたあとに、これを確認します。

```
destroys nothing:
  PASS  dirty repo: uncommitted work intact
  PASS  dirty repo: HEAD did not move
  PASS  dirty repo: still dirty (nothing was stashed)
  PASS  no stash was ever created
  PASS  detached HEAD: untouched
  PASS  mid-rebase: still mid-rebase
  PASS  mid-rebase: HEAD did not move
  PASS  diverged main: local commit not discarded
  PASS  diverged: HEAD did not move
```

**大事なのは、この「何もしなかった」側のテストです。**
「ちゃんと pull できた」より、「触ってはいけないものに触らなかった」の方が、
朝いちばんに黙って走るスクリプトには効きます。

同じテストを Node 版と PowerShell 版の両方に当てているので、
実装が 2 つに分かれても挙動がずれません。CI で Ubuntu / macOS / Windows で回しています。

### 登録

**Windows（タスクスケジューラ）**

```powershell
$a = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\Dev\ai-workforce\kit\scripts\pull-all.ps1" -Root C:\Dev'
$t = New-ScheduledTaskTrigger -AtLogOn
$t.Delay = "PT1M"
Register-ScheduledTask -TaskName "AIWF pull-all" -Action $a -Trigger $t
```

`PT1M` の遅延は、ネットワークが上がる前に走って全部失敗するのを避けるためです。

**macOS / Linux（cron）**

```cron
@reboot sleep 60 && /usr/bin/node ~/Dev/ai-workforce/kit/scripts/pull-all.mjs --root ~/Dev --quiet
```

同じ理由で `sleep 60` を入れています。

---

## ローカルが古いことに気づけない問題

手元の Claude Code から GitHub に直接 push して作業していると、
**ローカルのリポジトリだけが取り残されます**。

実際、あるプロジェクトでローカルが 17 コミット遅れていたことに、しばらく気づきませんでした。
push する側は最新なので、何も困らない。困るのは、次にローカルで作業を始めたときです。

`pull-all` はこれの対策でもあります。

---

## プロジェクトを取り違える問題

`musubu` の作業を `hanami-nail-prototype` で実行された、という事故があります。

原因は単純で、両方 Next.js App Router + Supabase なので、
**途中まで違和感なく動いてしまう**からです。

対策は 2 つ、どちらも安いので両方やります。

1. **プロンプトの冒頭に絶対パスを書く**（[03](03-division-of-labor.md)）
2. **共通 `CLAUDE.md` に「作業前に `pwd` で一致を確認する」を入れる**

これは「気をつける」で防げる類の事故ではありません。仕組みで塞ぎます。

---

## 各プロジェクトの CLAUDE.md を、記憶の置き場にする

複数案件で一番失われるのは、**「なぜそうなっているか」**です。

3 か月前の自分がなぜその実装にしたのか、コードからは分かりません。
だから各プロジェクトの `CLAUDE.md` に「触ってはいけないもの」「既知の落とし穴」を書きます。

これは AI のためであると同時に、**3 か月後の自分のため**です。
どちらも同じくらい記憶がありません。

## Node 版の引数チェック

`pull-all.mjs` は、引数の誤りをログ作成・Git 実行前に検出し、終了コード2で停止します。
受け付ける指定は `--root`、`--repos`、`--log-dir`、`--retention-days`、`--dry-run`、`--quiet` です。
値を必要とする指定は、オプション名の次に空白を挟んで渡してください。
未知の指定、同じオプションの重複、空の値、余分な位置引数は拒否します。

`--repos` はルート直下のフォルダ名をカンマ区切りで指定します。
空の要素、`.`、`..`、パス区切り文字、コロンは受け付けません。
これは引数形式の検査で、シンボリックリンクの参照先を制限するものではありません。
`--retention-days` は1以上の安全な整数に限定します。小数・負数・0は拒否します。

```powershell
node kit/scripts/pull-all.mjs --root C:\Dev --repos api,web --retention-days 30 --dry-run
```

終了コードは通常完了・安全なスキップが0、更新失敗が1、Node 版の引数エラーが2です。
今回の検査は Linux / Node の39項目で成功しました。PowerShell 版の引数処理は今回変更していません。

## 更新先フォルダの事前確認

Node / PowerShell 両版とも、ルートが既存のディレクトリであることをログ作成前に確認します。
存在しないパスや通常ファイルを指定した場合は、説明を表示して終了コード1で停止します。
これにより、ログ作成が誤った更新先フォルダを新規作成し、0件更新で成功終了する問題を防ぎます。
フォルダの読み取り権限や、確認後にパスが変わる競合まで保証する検査ではありません。
Linux / Node の変更後スイートは41件成功。PowerShell 版の今回の実行は未検証です。

## dry-run のログ保持

Node 版の `--dry-run` は、更新予定を画面に表示し、ログファイルやログ用ディレクトリを作成しません。
既存ログへの追記と保持期間を過ぎたログの削除も行いません。
以前は dry-run でもログを作成し、古いログを削除していました。
`--quiet` を併用すると通常の表示も抑止されるため、予定を確認する際は付けないでください。
Git の任意のインデックス更新を抑止するため、dry-run では `GIT_OPTIONAL_LOCKS=0` を設定します。
PowerShell 版では `-DryRun` を指定すると、同じく取得・ブランチ更新・ログの作成や削除をせずに予定を表示します。

```powershell
.\kit\scripts\pull-all.ps1 -Root C:\Dev -Repos api,web -DryRun
```

リモートには接続しないため、実際に fast-forward できるかや認証が成功するかは確認しません。
PowerShell 版の実行検証は未完了です。
変更後の Linux / Node スイートは44件成功しています。

## 作業状態を検査できない場合

Git のインデックス破損などで `git status` が失敗した場合、`fail/status` を記録し、
そのリポジトリの取得・更新を行いません。全体の終了コードは1になります。
未コミット変更を正常に検出した `skip/dirty` と区別します。
インデックスの自動修復は行わず、元のファイルを保持します。
Node / PowerShell 両版を修正し、Linux / Node の検査は47件成功。PowerShell は未実行です。

## 名前で指定した更新先の確認

`--repos` を指定すると、すべての指定先がディレクトリであり、`.git` が存在し、
Git が管理ディレクトリを解決できることを、ログ作成・更新前に確認します。
存在しない名前、通常フォルダ、壊れた `.git` が含まれる場合は終了コード1で全体を止めます。
同じ名前の重複指定は1回にまとめます。自動検出時は通常フォルダが混在していても構いません。
これは更新の事前確認で、通信失敗時の一括ロールバックやパス変更の競合を防ぐ仕組みではありません。
PowerShell 版の `-Repos` にも同じ事前確認を追加しました。PowerShell では `-Repos api,web` のように配列として指定します。空の名前やパス区切りを含む指定は拒否します。PowerShell 本体での実行は未検証です。
Linux / Node の変更後テストは51件成功しました。

## 作業ツリーがきれいでも操作途中なら停止

`REVERT_HEAD` または `sequencer` が残っているリポジトリも `skip/in-progress` としてスキップします。
競合を解消した後など、差分がなくても Git の操作が完了していない場合があります。
自動更新はその状態を削除せず、取得やブランチ更新も行いません。
実際に競合させた revert を HEAD と同じ内容に戻したケースと、sequencer 状態を配置したケースを共通テストへ追加しました。
