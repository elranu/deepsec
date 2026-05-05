# GitHub Copilot Pro+ via ACP

deepsec supports **GitHub Copilot Pro+** as an AI backend through the
`--agent acp` flag. This routes security analysis through the GitHub Copilot
chat completions API, giving you access to the frontier models available in
your Copilot Pro+ subscription (GPT-4o, Claude 3.5 Sonnet, Gemini 1.5 Pro,
o3-mini, and more).

## Requirements

| Requirement | Notes |
|---|---|
| **GitHub Copilot Pro+** subscription | Copilot Individual, Business, or Enterprise; the ACP backend accesses whatever models your plan provides |
| **GitHub token with `copilot` scope** | See authentication options below |
| **Node.js ≥ 22** | Same as the rest of deepsec |

## Authentication

### Option 1 — GitHub CLI (recommended for local development)

The GitHub CLI is the lowest-friction path: deepsec calls `gh auth token`
automatically when no explicit token env var is set.

```bash
# 1. Install the GitHub CLI
#    https://cli.github.com/
brew install gh           # macOS
sudo apt install gh       # Debian / Ubuntu

# 2. Log in to GitHub
gh auth login

# 3. Add the copilot scope to your token
gh auth refresh --scopes copilot

# 4. Verify the token works
gh auth status
```

After step 3, running `gh auth token` will return an OAuth token that deepsec
can use. No `.env.local` changes are needed.

**Caveat:** The `copilot` scope is only needed to call the Copilot API
directly. If your GitHub CLI session already includes that scope (e.g.,
you previously granted it via `gh auth refresh --scopes copilot`), step 3
may be a no-op.

---

### Option 2 — Personal Access Token (PAT)

Create a fine-grained or classic PAT with the `copilot` permission and set it
in `.env.local`:

```bash
# Fine-grained PAT (recommended):
#   https://github.com/settings/personal-access-tokens/new
#   → Account permissions → GitHub Copilot → Read-only
GH_COPILOT_TOKEN=github_pat_…

# Classic PAT:
#   https://github.com/settings/tokens/new
#   → Scopes: copilot
GITHUB_TOKEN=ghp_…
```

`GH_COPILOT_TOKEN` takes priority over `GITHUB_TOKEN` when both are set.

---

### Option 3 — CI / GitHub Actions

In GitHub Actions the `GITHUB_TOKEN` provided by the runner usually has the
`copilot` permission when Copilot is enabled for the repository. Set it as an
environment variable:

```yaml
- name: Run deepsec with GitHub Copilot
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  run: pnpm deepsec process --project-id my-app --agent acp
```

If `GITHUB_TOKEN` does not have the `copilot` scope (common in forks), create
a PAT with copilot access and store it as a repository secret instead:

```yaml
env:
  GH_COPILOT_TOKEN: ${{ secrets.GH_COPILOT_TOKEN }}
```

---

## Token resolution order

When the ACP backend needs a token it checks, in order:

1. `GH_COPILOT_TOKEN` env var
2. `GITHUB_TOKEN` env var
3. `gh auth token` (GitHub CLI session, local runs only)

If none are available, deepsec throws a clear error explaining how to fix it.

---

## Supported models

All models available in your Copilot Pro+ plan can be used via the `--model`
flag. Common options:

| Model | Notes |
|---|---|
| `gpt-4o` (**default**) | Strong reasoning, fast, well-suited for code analysis |
| `gpt-4o-mini` | Faster and cheaper; use for initial sweeps |
| `claude-3.5-sonnet` | Excellent for nuanced security reasoning |
| `o3-mini` | Best for complex multi-step reasoning tasks |
| `gemini-1.5-pro` | Large context window; good for big files |

Model availability depends on your Copilot plan tier. If a model is not
included in your plan, the API will return an error indicating the model is
unavailable — switch to a different model.

---

## Running deepsec with GitHub Copilot

```bash
# Default model (gpt-4o):
pnpm deepsec process --project-id my-app --agent acp

# Specify a different model:
pnpm deepsec process --project-id my-app --agent acp --model claude-3.5-sonnet

# Revalidate findings with GitHub Copilot:
pnpm deepsec revalidate --project-id my-app --agent acp --model gpt-4o

# Set as the default agent in deepsec.config.ts:
```

```ts
// deepsec.config.ts
import { defineConfig } from "deepsec/config";

export default defineConfig({
  projects: [{ id: "my-app", root: "../my-app" }],
  defaultAgent: "acp",       // use GitHub Copilot by default
});
```

---

## How ACP differs from Claude and Codex backends

| | `claude-agent-sdk` | `codex` | `acp` (GitHub Copilot) |
|---|---|---|---|
| **Filesystem access** | Tool loop (Read/Grep/Glob) | Tool loop (same) | Files read locally and bundled into prompt |
| **Context window** | Multi-turn, unlimited files | Multi-turn, unlimited files | Single-shot per batch; files truncated at 80 KB |
| **Cost model** | Per-token via Anthropic | Per-token via OpenAI | Counted against your Copilot Pro+ plan |
| **Tool calls** | Yes | Yes | No (static analysis via prompt) |
| **Refusal check** | Yes (follow-up turn) | Yes (follow-up turn) | No additional turn |

Because the ACP backend includes file contents inline, very large files are
truncated at **80,000 characters** per file. Reduce `--batch-size` if many
of your candidate files are large (> 80 KB):

```bash
pnpm deepsec process --project-id my-app --agent acp --batch-size 2
```

---

## Troubleshooting

### `GitHub Copilot API 401`

The token does not have the `copilot` scope or has expired.

```bash
gh auth refresh --scopes copilot
```

### `GitHub Copilot API 403`

Your Copilot plan does not include access to the requested model, or the API
is not enabled for your account. Check your plan and try a different model.

### `GitHub Copilot API 422` / `model not found`

The model identifier you passed to `--model` is not recognised. Check the
list of [supported models](#supported-models) above or consult your Copilot
plan details.

### `Missing GitHub Copilot credentials for --agent acp`

deepsec could not find a token. Follow the [authentication steps](#authentication)
above. For local runs, the fastest fix is:

```bash
gh auth login && gh auth refresh --scopes copilot
```

### Files are truncated

Files larger than 80 KB are truncated in the prompt sent to GitHub Copilot.
You can:
- Reduce `--batch-size` so each batch contains fewer, larger files
- Use the Claude or Codex backend for large files (they read files via tool
  loop without size limits in the prompt)
