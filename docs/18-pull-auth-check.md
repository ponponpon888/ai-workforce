# 自動更新の認証待ちを動作で検査する

`test-pull-all.mjs` の認証検査を、ソース内の環境変数名の検索から実際の Git の動作へ置き換えました。
既存の23項目のうち1項目を置き換えているため、テスト数は23のままです。

## 検査の仕組み

`check-pull-auth-fixture.mjs` が一時リポジトリと `127.0.0.1` の空きポートの HTTP サーバーを作ります。
サーバーは HTTP 401 と Basic 認証要求だけを返します。外部サービスや本物の認証情報は使いません。
Git のグローバル・システム設定は隔離し、継承された Git の上書き設定・プロキシ・認証ヘルパーを使わない構成にします。

検査開始時は `GIT_TERMINAL_PROMPT=1`、`GCM_INTERACTIVE=always` に設定します。
その後 `pull-all` を実行し、Git が呼ぶ検査用の認証ヘルパーで、実際に渡された値を記録します。
ヘルパーは認証情報を返しません。

次のすべてを満たす必要があります。

- 実際の Git が HTTP 認証要求に到達し、認証ヘルパーを呼ぶ。
- ヘルパーが `GIT_TERMINAL_PROMPT=0` と `GCM_INTERACTIVE=never` を受け取る。
- `pull-all` が15秒以内に終了コード1で終了する。
- ログに端末プロンプト無効のエラーと `fail/pull` が残る。
- 元のコミットとファイルが保持され、作業ツリーが clean のままである。

実行後はサーバーを停止し、一時ファイルを片付けます。
この検査は既存スイートから呼ぶため、CI のジョブや呼び出しを追加する必要はありません。

## 実行方法

リポジトリのルートで実行します。

```powershell
node kit/scripts/test-pull-all.mjs
node kit/scripts/test-pull-all.mjs --target ps --pwsh pwsh
node kit/scripts/test-pull-all.mjs --target ps --pwsh powershell.exe
```

2・3行目は対応する PowerShell をインストールした環境で実行してください。

## 確認範囲と限界

Linux / Node v24.19.0 で23項目成功を確認しました。
さらに、一時コピーから2種類の環境変数設定をそれぞれ削除し、どちらも新しい検査が失敗することを確認しています。
元の `pull-all` 実装は変更していません。

PowerShell 5.1 / 7、Windows、macOS での今回の検査は未実行です。
Git Credential Manager 本体の GUI 抑制は検査しておらず、`GCM_INTERACTIVE` が実行中の Git ヘルパーへ渡ることまでを確認します。
ネットワークのタイムアウト全般、SSH 認証、独自ヘルパーの停止、作業ブランチからの fetch 認証失敗は対象外です。
検査側の15秒制限はテスト停止を防ぐためのもので、製品の Git 呼び出しにタイムアウトを追加する変更ではありません。
