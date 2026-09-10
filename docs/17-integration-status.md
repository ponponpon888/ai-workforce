# 修正の統合状況（2026-09-09）

PR #9 を土台に、#10〜#15 の変更をまとめた検証用ブランチです。
各 PR の設定・インストーラ・フックを一緒に使える状態にし、CI のテスト追加が競合した箇所を整理しています。
リリース完了や実環境での動作確認済みを意味しません。

## 取り込んだ変更

| PR | 取り込んだコミット | 内容 |
|---|---|---|
| #9 | `58fc082357c4cc50a05e9a41172b36ec455713c6` | 落とし穴レコード、SQL ファイル検査、CI 構成 |
| #10 | `f116370405ad54b7c39b187e5eddd2fa0313f51f` | 設定形式の修正、読み取り専用 doctor |
| #11 | `eb119084d4343abf9afd6c62a4da97dfb4db8e89` | SQL の文境界、完全一致・一度限りの承認 |
| #12 | `5191dd7ef37a7d5274b5d6ba4ff5faffa7ee31c2` | 落とし穴の静的検査 |
| #13 | `db60016c45ea7d76e1e2107d26772c200e32babb` | インストーラ事前検査、バックアップ保持、パス処理 |
| #14 | `56f4815f73f8d46694bda002ec956aaa3791dced` | 文書内の未完了マーカー検査 |
| #15 | `52b2f5b4f58365e055b4ff70d7f03ed838c2c14b` | 単体試行、既存設定への手動取り込み、復元手順 |

元 PR の後続変更は自動で取り込まれません。更新する際はこの表のコミットとの差分を確認してください。
CI の既存ジョブ名と OS 選択を保ち、それぞれの追加テスト・ファイル存在確認・doctor を残しました。
新しいジョブは追加していません。

## 現在の統合版の検証結果

Linux / Node の記録は下記のまま残します。Windows での実行結果は
[Windows での実行（2026-09-10）](#windows-での実行2026-09-10)にあります。両者を混ぜません。

検証対象コード: `980393f9ba2f894aff8ec091777d9167a0d27801`。
このコミットと同一のローカルコードを Linux / Node v24.19.0 で検証しました。
全11スイートを実行し、見つかった文書参照切れを修正後、影響するレコード検証51件を再実行しました。最終結果は合計377件成功・失敗0件です。今回の記録更新は文書のみです。

前回の375件はロードマップの最終整理前の結果でした。整理で見出しを変更した後のレコード検証が漏れ、`perm-003` / `perm-004` の参照が切れていました。今回は元の見出しを復元し、12レコードの検証とインデックスの一致を確認しています。

| スクリプト（`kit/scripts/`） | 成功数 |
|---|---:|
| `test-check-doc-todos.mjs` | 13 |
| `test-doctor.mjs` | 28 |
| `test-guard-secrets.mjs` | 65 |
| `test-guard-sql.mjs` | 44 |
| `test-install-backups.mjs` | 27 |
| `test-installed-approval.mjs` | 1 |
| `test-lint-pitfalls.mjs` | 38 |
| `test-pull-all.mjs` | 72 |
| `test-sql-boundaries.mjs` | 18 |
| `test-validate-pitfalls.mjs` | 51 |
| `test-verify-installers.mjs` | 20 |

テンプレートの doctor は `static-pass`。落とし穴の静的検査は5件成功・違反0・不明0、7レコードは検査対象外です。
12レコードの形式検証、生成インデックスのバイト一致、文書の未完了マーカー0件も確認しました。
静的検査は実行環境全体の安全性を証明するものではありません。

## 今回解消した接続・CIの不整合

- PowerShell版インストーラは実行環境に応じて `pwsh` / `powershell.exe` を登録。doctor は両形式を認識します。
- 配置済みの SQL・秘密ファイルフックを、生成された設定のコマンドで実行する検査を PowerShell にも対応。CI の7系・5.1へ接続しました。
- CI の正常終了検査で不正なリポジトリ指定を使っていたため、実リポジトリの dry-run に修正しました。
- ワークフローの YAML 構文と PowerShell ファイルの ASCII 制約は確認済み。PowerShell 本体と GitHub Actions の実行成功は未確認です。

## 統合後の基本機能

- 配置した承認スクリプトと SQL フックの接続、完全一致・期限付き・一度限りの承認。
- 秘密ファイルの Windows パス・拡張子付き実行ファイルの判定、公開テンプレート例外の範囲修正。
- 自動更新の指定先事前検査、操作途中・未追跡ファイル・サブモジュール変更の保護。
- 取得・状態・ブランチ・更新・ログの失敗を報告。非対話設定とログも変更しない dry-run。
- インストーラのバックアップ保持、doctor、落とし穴と文書の静的検査、導入・手動マージ・復元手順。
- 基本6スイートの一括ランナー。対象名の誤入力を拒否し、選択範囲・各スイート結果・未検証理由を JSON に記録。
- SQL の PowerShell テストは固有の一時フォルダを使用し、既存の承認フォルダは削除せず拒否。

詳細は [自動更新](04-multi-project.md)、[認証検査](18-pull-auth-check.md)、[検証手順](12-installer-backups.md) を参照してください。
テストは一時ファイル・検査用リポジトリを使用し、本番 DB やユーザーの作業リポジトリには接続しません。

## Windows での実行（2026-09-10）

実行環境: Windows 11 Pro 10.0.26200 / Windows PowerShell 5.1.26100.9278 / Node v24.13.0 / git 2.52.0。
PowerShell 7 は未導入のため、`--target powershell-7` は `unverified` のままです。導入はしていません。

Linux で通っていたコードが Windows で 2 か所落ちました。どちらも Windows でしか出ません。

- **`test-install-backups.mjs` の Node 対象が 23 件中 14 件失敗。** `node --import` に
  Windows の絶対パスを渡していました。ESM ローダはこれを `c:` というスキームとして読み、
  インストーラに届く前に `ERR_UNSUPPORTED_ESM_URL_SCHEME` で止まります。POSIX の絶対パスは
  そのまま指定子として解決されるため、Linux では表面化しませんでした。
  `pathToFileURL()` を通して修正し、23 件全て成功しています。
- **インストーラのテストが `$ConfirmPreference` の既定値に依存していました。** `install.ps1` は
  `ConfirmImpact = 'Medium'` なので、既定の `High` のままなら確認は出ません。裏を返すと、
  この既定が崩れた瞬間に全ての呼び出しが確認経路に入ります。実測では、`$ConfirmPreference = 'Low'`
  にすると `-Confirm:$false` なしの呼び出しは `NullReferenceException`（`install.ps1:219`）で落ち、
  コンソールがあれば入力待ちで止まります。テスト側の非対話呼び出しに `-Confirm:$false` を明示しました。
  インストーラ本体、通常利用時の確認、`-WhatIf` はいずれも変更していません。

修正後の結果です。`--suite core --target windows-powershell-5.1 --json` は終了コード 0、
6 スイート全て `passed`。JSON は対話メッセージで壊れていません（ランナーは子プロセスの
標準出力・標準エラーをパイプで受け取り、失敗時のみ `JSON.stringify` 経由で埋め込むため）。

| スクリプト（`kit/scripts/`） | Windows / Node |
|---|---:|
| `test-check-doc-todos.mjs` | 13 |
| `test-doctor.mjs` | 28 |
| `test-guard-secrets.mjs` | 65 |
| `test-guard-sql.mjs` | 44 |
| `test-install-backups.mjs` | 23 |
| `test-installed-approval.mjs` | 1 |
| `test-lint-pitfalls.mjs` | 38 |
| `test-pull-all.mjs` | 72 |
| `test-sql-boundaries.mjs` | 18 |
| `test-validate-pitfalls.mjs` | 51 |
| `test-verify-installers.mjs` | 20 |

Windows の `test-install-backups.mjs` が 23 件なのは、POSIX 専用の 4 件が動かないためです。
Linux の 27 件と同じ範囲ではありません。静的検査は doctor が `static-pass`、レコード検証 12 件、
静的検査 5 件成功・違反 0・不明 0、文書の未完了マーカー 0 件。
生成インデックスは再生成してもバイト一致でした（Windows では改行変換により
`git status` だけが差分を示しますが、内容は最新です）。

### 未解決: 承認の一度限りが Windows で破れる

`test-sql-boundaries.mjs` の「only one concurrent call consumes approval」が Windows で
断続的に失敗します。同一の承認に対して 6 並列で実行し、6 回中 1 回程度、**2 プロセスが承認を
通過**します（いずれも終了コード 0・標準エラーは空。内部エラーによる誤許可ではありません）。
専用の再現スクリプトでは 40 ラウンド中 4 回（10%）でした。

原因は `kit/claude/hooks/guard-sql.mjs` の `isApproved()` です。`renameSync` の原子性で
取得者を 1 つに絞る設計ですが、Windows の rename は開いたハンドル経由で行われるため、
2 番目の呼び出しが「1 番目が既に改名した後のファイル」を自分の名前へ改名でき、
両方が成功します。POSIX で成り立つ排他性が Windows では成り立ちません。

**未修正です。** 中核の保証に関わる変更で、排他ロックを入れると異常終了時に
そのフィンガープリントが恒久的に拒否側へ倒れる（安全側だが復旧に手作業が要る）という
判断を伴うため、方針を決めてから直します。Linux / macOS への影響は未測定です。

## 基本6スイートの一括確認

リポジトリのルートで実行します。Windows PowerShell 5.1 を検証する場合:

```powershell
node kit/scripts/verify-installers.mjs --suite core --target windows-powershell-5.1 --json
```

全ランタイムは `--target all`、Node のみは `--target node` です。
対象スイートは installed-approval / installers / pull-all / guard-secrets / guard-sql / sql-boundaries の6つで、開発用の全11スイートとは範囲が異なります。
終了コード0は選択範囲の全成功、1はテスト失敗、2は未検証の対象ありです。
Linux で実行した `--suite core --target all --json` は Node の6スイート成功、PowerShell 7 はランタイム不在、Windows PowerShell 5.1 は Windows 必須として終了コード2でした。

## リリース前に残る確認

| 対象 | 状況 |
|---|---|
| Linux / Node | 全11スイート377件成功 |
| Windows PowerShell 5.1 | 基本6スイート成功。全11スイートも成功（`test-sql-boundaries` の並列1件を除く） |
| PowerShell 7 | 未導入のため未検証。導入していない |
| Windows の Node | 実行済み。上記2件を修正して成功 |
| macOS の Node | 統合版は未実行 |
| 承認の一度限り（Windows） | **失敗。`isApproved()` の rename が排他にならず、10%程度で2プロセスが通過。未修正** |
| GitHub Actions | 課金停止で実行不可。18ジョブすべて `steps: 0`、注釈は `recent account payments have failed or your spending limit needs to be increased` |
| Claude Code 本体 | 設定受理・優先順位・モード・フック接続・パス記法は未検証 |
| 素の環境 | 新規導入からの確認が未完了 |
| 実プロジェクトの DB ロール | 未検証。対象 DB に変更は加えていない |

CI が止まっている原因は特定できました。**コードの失敗ではありません。** 2026-09-09 の
全 run が 5〜6 秒で失敗し、18 ジョブすべてがステップ 0 件で、注釈は支払い・上限に関する
ものです。ランナーが割り当てられないため、どのステップも実行されていません。
解消できるのはアカウントの課金設定だけで、こちらでは変更していません。
ワークフロー側は PR で macOS を外す対策を既に入れており、これ以上コード側でできることはありません。
ローカル成功を CI 成功として扱わず、過去の Windows 実測とも区別します。
基本機能の実装とローカル検証は完了しましたが、マージ・公開はまだ行っていません。
その他の制約と公開条件は [ロードマップ](../ROADMAP.md) を参照してください。
