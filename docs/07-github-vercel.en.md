# 07. The holes in GitHub and Vercel

日本語: [07-github-vercel.md](07-github-vercel.md)

[06](06-supabase-mcp.en.md) closed Supabase, which leaves these two on the chat side.

The conclusion first: **GitHub can be constrained more finely than I expected. Vercel I have not
managed to constrain.**

---

## GitHub

### 1. Put the MCP server in read-only mode

The official GitHub MCP server has a read-only mode.

**Local (binary / Docker)**

| | Name |
|---|---|
| CLI flag | `--read-only` |
| Environment variable | `GITHUB_READ_ONLY` |

```bash
docker run -i --rm \
  -e GITHUB_PERSONAL_ACCESS_TOKEN=<your-token> \
  -e GITHUB_READ_ONLY=1 \
  ghcr.io/github/github-mcp-server
```

**Remote (hosted)**

Put it in the URL, or pass it as a header.

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

How read-only takes effect is the part that matters. From the documentation:

> When active, this mode will disable all tools that are not read-only
> even if they were requested.

**A toolset that asks for write tools does not win; read-only overrides it and disables them.**
So a misconfiguration does not fall in the direction of opening a hole.

### 2. Narrow the tools

| Purpose | Local | Remote |
|---|---|---|
| Select toolsets | `--toolsets` / `GITHUB_TOOLSETS` | `X-MCP-Toolsets` / `/x/{toolset}` |
| Select individual tools | `--tools` / `GITHUB_TOOLS` | `X-MCP-Tools` |
| Exclude individual tools | `--exclude-tools` / `GITHUB_EXCLUDE_TOOLS` | `X-MCP-Exclude-Tools` |
| Read-only | `--read-only` / `GITHUB_READ_ONLY` | `X-MCP-Readonly` / `/readonly` |
| Lockdown | `--lockdown-mode` / `GITHUB_LOCKDOWN_MODE` | `X-MCP-Lockdown` |

With nothing specified, the defaults are `context`, `issues`, `pull_requests`, `repos`, `users`.

`--exclude-tools` wins over everything else.

> Listed tools are removed regardless of any other configuration —
> even if their toolset is enabled or they are individually added.

Which gives you the middle ground: writes allowed, merging not.

```
--toolsets=pull_requests --exclude-tools=merge_pull_request
```

### 3. Lockdown mode (against prompt injection)

The GitHub version of what [06](06-supabase-mcp.en.md) describes. Anyone can write the body of an
issue or a pull request.

With `--lockdown-mode` enabled, **on public repositories the agent is only shown content written
by people with push access**. Private repositories are unaffected.

The documentation itself says:

> Lockdown mode is a best-effort content filter meant to reduce prompt-injection
> risk from untrusted repository content; **it is not an authorization boundary.**

A filter, not a wall. Do not lean on it.

### 4. PAT scopes

Use a fine-grained PAT and narrow it to `Only select repositories`.

To "read the code and open a pull request", this is all it needs:

| Permission | Level |
|---|---|
| `Metadata` | Read-only (required, granted automatically) |
| `Contents` | Read and write |
| `Pull requests` | Read and write |

**Explicitly set to `No access`:**

`Administration` (it can change repository settings and rulesets), `Workflows` (it can rewrite
`.github/workflows`), `Secrets`, `Variables`, `Actions`, `Environments`, `Deployments`,
`Webhooks`, `Pages`, and every organization permission.

Hand over `Administration` and **the agent can remove the ruleset that is stopping it**. That is
the one to never grant.

### 5. A PAT cannot stop force-push or deletion

This was the biggest finding.

The REST API permissions reference says:

- Update a reference (including `force: true`) → requires `Contents` (write)
- Delete a reference → requires `Contents` (write)
- An ordinary push → also `Contents` (write)

**One single permission allows an ordinary push, a force push and a deletion alike.** There is no
fine-grained PAT granularity that says "push yes, force-push no".

What stops them is not the token. It is **a ruleset on the repository**.

| What to stop | Rule |
|---|---|
| Force push | `Block force pushes` (on by default) |
| Branch deletion | `Restrict deletions` (on by default) |
| Direct push to the default branch | `Require a pull request before merging` |
| Merging without review | `Required approvals` on the same rule, set to 1 or more |

And the trap:

> When you create a ruleset, you can allow certain users to bypass the rules
> in the ruleset.

**Put the agent's account or GitHub App on the bypass list and the ruleset means nothing.** Also
remember to set Enforcement status to `Active`; `Disabled` enforces nothing.

### 6. What GitHub itself does

GitHub's documentation for its own cloud agent lists the official mitigations. They work as
general principles.

> Copilot cloud agent only has the ability to push to a single branch

> Draft pull requests created by Copilot cloud agent must be reviewed and merged by a human

> GitHub Actions workflows don't run on a pull request until a user with write access
> approves them, which prevents workflows from running automatically.

> the GitHub MCP server connects to GitHub using a specially scoped token
> that only has read-only access to the current repository

**The official default is read-only, current repository only, write tools off.** If your own setup
is looser than that, you should be able to say why.

---

## Vercel

Honestly: **not as constrained as GitHub.**

### What helps most is not a Vercel setting

**Route production deploys through the Git integration only**, and protect `main` with a ruleset.

Then the only path to production is "a merge into `main`", and `main` requires a pull request and
a review — so **the guardrail on the GitHub side becomes the guardrail on Vercel**.

As long as the agent deploys directly, no amount of Vercel configuration closes the hole. Go
through Git alone and almost no Vercel-specific configuration is needed.

### Settings I could confirm

| Goal | How |
|---|---|
| Stop automatic deploys from Git | `git.deploymentEnabled: false` in `vercel.json` |
| Block production alias assignment behind a check | `vercel project checks add --blocks deployment-alias` |
| Inspect or toggle deployment protection | `vercel project protection [enable\|disable]` |
| Pause a project | `POST /v1/projects/{projectId}/pause` |

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "git": {
    "deploymentEnabled": false
  }
}
```

### Some tools can spend money

One that is easy to miss: the Vercel MCP includes **tools that cost money**. Buying a domain,
upgrading a plan, buying credits.

I had been thinking only about breaking a database. **Operations you cannot undo include being
charged for something.** The shared `CLAUDE.md` rule — get an estimate and confirmation before any
operation that spends money — is aimed exactly here.

### What is still open

- Whether the Vercel MCP has per-tool filtering: I could not confirm it in the official
  documentation
- How to scope a token to a single project: also unconfirmed

**Writing "it is probably like this" would cost this document its credibility, so these stay
blank.** They get filled in when I know.

---

## Unconfirmed

Things I could not settle while writing this page:

- **Dynamic toolset discovery** (`--dynamic-toolsets` and similar): I could not find it in the
  current README or documentation. Second-hand sources say it once existed; I am not writing that
  down as fact
- **`--read-only` combined with the `http` command**: the repository has an issue saying
  `--read-only` does not disable write tools under the `http` command. Whether it is still open, I
  do not know. **If you use anything other than stdio, look at the tool list yourself**
- **What values `GITHUB_READ_ONLY` accepts**: the documentation only shows `1`. Whether `true`
  works is unconfirmed
- **Expiration presets for fine-grained PATs**: the documentation says only "select an
  expiration" without listing the options. What I could confirm: an organization's default maximum
  lifetime is 366 days, and no-expiry can be chosen but may be blocked by organization policy

---

## Sources

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
