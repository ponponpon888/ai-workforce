# 07. GitHub と Vercel の穴

[06](06-supabase-mcp.md) で Supabase を塞いだので、チャット側に残っているのはこの 2 つです。

先に結論を書くと、**GitHub は思っていたより細かく絞れました。Vercel は絞りきれていません。**

---

## GitHub

### 1. MCP サーバーを読み取り専用にする

公式の GitHub MCP サーバーには読み取り専用モードがあります。

**ローカル（バイナリ / Docker）**

| | 名前 |
|---|---|
| CLI フラグ | `--read-only` |
| 環境変数 | `GITHUB_READ_ONLY` |

```bash
docker run -i --rm \
  -e GITHUB_PERSONAL_ACCESS_TOKEN=<your-token> \
  -e GITHUB_READ_ONLY=1 \
  ghcr.io/github/github-mcp-server
```

**リモート（ホスト版）**

URL に付けるか、ヘッダーで渡します。

```
https://api.githubcopilot.com/mcp/x/all/readonly
```

```json
{
  "type": "http",
  "url": "https://api.githubcopilot.com/mcp/",
  "headers": {
    "X-MCP-Toolsets": "issues,repos,pull_requests",
    "X-MCP-Readonly": "true"
  }
}
```

read-only の効き方が重要です。ドキュメントにこうあります。

> When active, this mode will disable all tools that are not read-only
> even if they were requested.

**ツールセットで write ツールを要求していても、read-only が上書きして無効化します。**
つまり設定ミスで穴が開く方向には倒れません。

### 2. ツールを絞る

| 目的 | ローカル | リモート |
|---|---|---|
| ツールセット指定 | `--toolsets` / `GITHUB_TOOLSETS` | `X-MCP-Toolsets` / `/x/{toolset}` |
| 個別ツール指定 | `--tools` / `GITHUB_TOOLS` | `X-MCP-Tools` |
| 個別ツール除外 | `--exclude-tools` / `GITHUB_EXCLUDE_TOOLS` | `X-MCP-Exclude-Tools` |
| 読み取り専用 | `--read-only` / `GITHUB_READ_ONLY` | `X-MCP-Readonly` / `/readonly` |
| ロックダウン | `--lockdown-mode` / `GITHUB_LOCKDOWN_MODE` | `X-MCP-Lockdown` |

指定しない場合のデフォルトは `context`, `issues`, `pull_requests`, `repos`, `users` です。

`--exclude-tools` は最優先で効きます。

> Listed tools are removed regardless of any other configuration —
> even if their toolset is enabled or they are individually added.

書き込みは要るがマージはさせたくない、という中間が作れます。

```
--toolsets=pull_requests --exclude-tools=merge_pull_request
```

### 3. ロックダウンモード（プロンプトインジェクション対策）

[06](06-supabase-mcp.md) で書いた話の GitHub 版です。Issue や PR の本文は、誰でも書けます。

`--lockdown-mode` を有効にすると、**public リポジトリでは push 権限を持つ人が書いた内容しか
エージェントに見せなくなります**。private リポジトリは影響を受けません。

ただしドキュメント自身がこう書いています。

> Lockdown mode is a best-effort content filter meant to reduce prompt-injection
> risk from untrusted repository content; **it is not an authorization boundary.**

フィルタであって、権限の壁ではない。過信しないこと。

### 4. PAT のスコープ

fine-grained PAT で、対象リポジトリを `Only select repositories` に絞ります。

「コードを読んで PR を出す」ために要るのはこれだけです。

| 権限 | レベル |
|---|---|
| `Metadata` | Read-only（必須・自動付与） |
| `Contents` | Read and write |
| `Pull requests` | Read and write |

**明示的に `No access` にするもの:**

`Administration`（リポジトリ設定・ruleset を変えられてしまう）／`Workflows`（`.github/workflows`
を書き換えられる）／`Secrets`／`Variables`／`Actions`／`Environments`／`Deployments`／
`Webhooks`／`Pages`／組織権限すべて。

`Administration` を渡すと、**エージェントが自分を止めている ruleset を外せます**。
これは絶対に渡してはいけない 1 つです。

### 5. PAT では force-push と削除は止められない

ここが一番の発見でした。

REST API の権限表を見ると、こうなっています。

- Update a reference（`force: true` を含む）→ 必要な権限は `Contents` (write)
- Delete a reference → 必要な権限は `Contents` (write)
- 普通の push → 同じく `Contents` (write)

**同じ 1 つの権限が、普通の push も force-push も削除も全部許可します。**
fine-grained PAT の粒度に「push は許すが force-push は禁じる」は存在しません。

止めるのはトークンではなく、**リポジトリ側の ruleset** です。

| 止めたい行為 | ルール名 |
|---|---|
| force push | `Block force pushes`（既定で有効） |
| ブランチ削除 | `Restrict deletions`（既定で有効） |
| デフォルトブランチへの直接 push | `Require a pull request before merging` |
| レビューなしマージ | 同上の `Required approvals` を 1 以上 |

そして落とし穴。

> When you create a ruleset, you can allow certain users to bypass the rules
> in the ruleset.

**エージェントが使うアカウントや GitHub App を Bypass list に入れると、ruleset は無意味になります。**
Enforcement status を `Active` にすることも忘れずに。`Disabled` では強制されません。

### 6. GitHub 自身がやっていること

Copilot のクラウドエージェント向けドキュメントに、公式の緩和策が並んでいます。
汎用の原則として、そのまま使えます。

> Copilot cloud agent only has the ability to push to a single branch

> Draft pull requests created by Copilot cloud agent must be reviewed and merged by a human

> GitHub Actions workflows don't run on a pull request until a user with write access
> approves them, which prevents workflows from running automatically.

> the GitHub MCP server connects to GitHub using a specially scoped token
> that only has read-only access to the current repository

**公式のデフォルトが「読み取り専用・当該リポジトリのみ・書き込みツールは既定で不許可」です。**
自分の設定がそれより緩いなら、緩い理由を説明できるべきです。

---

## Vercel

正直に書きます。**GitHub ほど絞れていません。**

### 一番効くのは、Vercel の設定ではなく構造

**本番デプロイを Git 連携に一本化する。** そして `main` を ruleset で守る。

そうすると、本番に出る唯一の経路が「`main` へのマージ」になり、
`main` は PR とレビューを要求するので、**GitHub 側の歯止めがそのまま Vercel の歯止めになります**。

エージェントに直接デプロイさせている限り、Vercel 側でいくら設定を足しても穴は残ります。
逆に Git 一本化してしまえば、Vercel 固有の設定はほとんど要らなくなる。

### 確認できた設定

| やりたいこと | 手段 |
|---|---|
| Git からの自動デプロイを止める | `vercel.json` の `git.deploymentEnabled: false` |
| 本番エイリアスの割り当てをチェックで止める | `vercel project checks add --blocks deployment-alias` |
| デプロイ保護の確認・切替 | `vercel project protection [enable\|disable]` |
| プロジェクトを一時停止する | `POST /v1/projects/{projectId}/pause` |

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "git": {
    "deploymentEnabled": false
  }
}
```

### 買い物ができるツールがある

見落としやすい話をひとつ。Vercel の MCP には**課金が発生するツール**が含まれます。
ドメインの購入、プランのアップグレード、クレジットの購入。

DB を壊す話ばかり気にしていましたが、**取り消せない操作は課金にもあります**。
共通 `CLAUDE.md` の「課金が発生する操作は見積もりを出して確認を取る」は、ここに効きます。

### まだ塞げていないこと

- Vercel MCP にツール単位の絞り込みがあるかどうか、公式ドキュメントで確認できていません
- トークンをプロジェクト単位に絞る方法も未確認です

**「たぶんこうだろう」で書くとこのドキュメント全体の信用が落ちるので、空欄にしておきます。**
分かったら埋めます。

---

## 未確認事項

このページを書くにあたって、確認しきれなかったものを列挙しておきます。

- **動的ツールセット探索**（`--dynamic-toolsets` 等）: 現行の README とドキュメントに
  記載が見つかりませんでした。過去にあったという二次情報はありますが、書きません
- **`--read-only` と `http` コマンドの組み合わせ**: リポジトリに
  「`http` コマンドで `--read-only` が write ツールを止めない」という issue が存在します。
  未解決かどうかは未確認です。**stdio 以外で使う場合は、実際にツール一覧を目で確認してください**
- **`GITHUB_READ_ONLY` が受け付ける値**: ドキュメントの例は `1` のみ。`true` が通るかは未確認です
- **fine-grained PAT の有効期限のプリセット**: ドキュメントは「select an expiration」としか
  書いておらず、選択肢を列挙していません。組織のデフォルト最大有効期間が 366 日であること、
  無期限も選べるが組織ポリシーでブロックされうること、までが確認できた範囲です

---

## 出典

- [github/github-mcp-server README](https://github.com/github/github-mcp-server/blob/main/README.md)
- [github-mcp-server / server-configuration.md](https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md)
- [github-mcp-server / remote-server.md](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md)
- [Permissions required for fine-grained PATs](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)
- [REST API: Git references](https://docs.github.com/en/rest/git/refs)
- [Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
- [About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)
- [Risks and mitigations for GitHub Copilot cloud agent](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/risks-and-mitigations)
- [Vercel: Git configuration](https://vercel.com/docs/project-configuration/git-configuration)
- [Vercel CLI: project](https://vercel.com/docs/cli/project)
