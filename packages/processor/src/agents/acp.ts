/**
 * ACP (Agent Connect Protocol) agent plugin — integrates GitHub Copilot Pro+
 * models into deepsec via the GitHub Copilot chat completions API.
 *
 * Unlike the Claude or Codex backends (which get a tool loop on the local
 * filesystem), this agent reads candidate files itself and bundles their
 * contents into a single prompt that is sent to the Copilot API.  This
 * keeps the implementation stateless and dependency-free while still giving
 * the model full source context.
 *
 * Authentication (in priority order):
 *   1. GH_COPILOT_TOKEN env var — a GitHub token with the `copilot` scope
 *   2. GITHUB_TOKEN env var — any GitHub OAuth/PAT token with `copilot` scope
 *   3. `gh auth token` CLI fallback — reuses the session from `gh auth login`
 *
 * See docs/github-copilot-acp.md for the full setup guide.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { FileRecord } from "@deepsec/core";
import {
  backoff,
  isTransientError,
  MAX_ATTEMPTS,
  parseInvestigateResults,
  parseRevalidateVerdicts,
} from "./shared.js";
import type {
  AgentPlugin,
  AgentProgress,
  BatchMeta,
  InvestigateOutput,
  InvestigateParams,
  RevalidateOutput,
  RevalidateParams,
} from "./types.js";

export const DEFAULT_MODEL = "gpt-4o";
const DEFAULT_BASE_URL = "https://api.githubcopilot.com";
/** Per-file content cap — keeps the batch within typical context-window limits */
const MAX_FILE_CHARS = 80_000;

// ---------------------------------------------------------------------------
// File reading
// ---------------------------------------------------------------------------

function readFileSafe(filePath: string, projectRoot: string): string {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
  try {
    const content = fs.readFileSync(abs, "utf-8");
    if (content.length > MAX_FILE_CHARS) {
      return `${content.slice(0, MAX_FILE_CHARS)}\n\n[... truncated — file exceeds ${MAX_FILE_CHARS} chars ...]`;
    }
    return content;
  } catch {
    return "(file not readable)";
  }
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildAcpInvestigatePrompt(params: {
  promptTemplate: string;
  projectInfo: string;
  batch: FileRecord[];
  projectRoot: string;
}): string {
  const { promptTemplate, projectInfo, batch, projectRoot } = params;

  const fileListWithContents = batch
    .map((r) => {
      const matchDetails = r.candidates
        .map((m) => {
          const lines = m.lineNumbers.join(", ");
          return `    - [${m.vulnSlug}] L${lines}: ${m.matchedPattern}`;
        })
        .join("\n");

      const content = readFileSafe(r.filePath, projectRoot);

      return `## File: ${r.filePath}

**Scanner flags:**
${matchDetails}

**File contents:**
\`\`\`
${content}
\`\`\`
`;
    })
    .join("\n---\n\n");

  return `${promptTemplate}

${projectInfo ? `## Project Context\n\n${projectInfo}\n` : ""}
## Target Files

The scanner flagged the following files as **candidates** worth investigating. The file contents are included below — read them carefully.

**Do not limit yourself to the flagged patterns.** The scanner reasons are just starting points. Look for ANY security issue in each file.

${fileListWithContents}

## Investigation Instructions

For each file:
1. **Read the file contents carefully** (provided above)
2. **Trace data flows** — where does input come from? Is it user-controlled?
3. **Check for mitigations** — sanitization, validation, auth middleware, or framework protection?
4. **Think broadly** — look for issues beyond what the scanner flagged. Reason about logic bugs, race conditions, missing checks, etc.

## Output Format

After your investigation, output a JSON block with your findings for EACH file:

\`\`\`json
[
  {
    "filePath": "relative/path/to/file.ts",
    "findings": [
      {
        "severity": "CRITICAL|HIGH|MEDIUM|HIGH_BUG|BUG",
        "vulnSlug": "the-vuln-slug-or-other",
        "title": "Brief title of the issue",
        "description": "Detailed description of the vulnerability, the attack scenario, and evidence from the code",
        "lineNumbers": [10, 15],
        "recommendation": "How to fix this vulnerability",
        "confidence": "high|medium|low"
      }
    ]
  }
]
\`\`\`

If a file has no real vulnerabilities after thorough investigation, include it with an empty findings array.`;
}

function buildAcpRevalidatePrompt(params: {
  batch: FileRecord[];
  projectRoot: string;
  projectInfo: string;
  force: boolean;
}): { prompt: string; totalFindings: number } {
  const { batch, projectRoot, projectInfo, force } = params;

  const fileSections: string[] = [];
  let totalFindings = 0;

  for (const file of batch) {
    const findingsToCheck = file.findings.filter((f) => force || !f.revalidation);
    if (findingsToCheck.length === 0) continue;
    totalFindings += findingsToCheck.length;

    const findingsList = findingsToCheck
      .map((f) => {
        return `### Finding: ${f.title}
- **Severity:** ${f.severity}
- **Slug:** ${f.vulnSlug}
- **Lines:** ${f.lineNumbers.join(", ")}
- **Confidence:** ${f.confidence}
- **Description:** ${f.description}
- **Recommendation:** ${f.recommendation}`;
      })
      .join("\n\n");

    const content = readFileSafe(file.filePath, projectRoot);

    fileSections.push(`## File: ${file.filePath}

**File contents:**
\`\`\`
${content}
\`\`\`

**Findings to revalidate:**

${findingsList}`);
  }

  const prompt = `You are a world-class security researcher performing an adversarial review of vulnerability findings. Your goal is to determine, with high confidence, whether each finding is real and exploitable.

**Static analysis only.** Do NOT attempt to reproduce, exploit, or trigger any finding. Review the source code only.

${projectInfo ? `## Project Context\n\n${projectInfo}\n` : ""}

${fileSections.join("\n---\n\n")}

## Investigation Process

For EACH finding:
1. **Read the file contents carefully** (provided above)
2. **Trace the data flow end-to-end** — Where does the input enter? What transformations happen?
3. **Think like an attacker** — Construct a concrete attack scenario. If you can't, it's likely a false positive.
4. **Check for framework-level protections** — middleware, auth guards, CSRF tokens.
5. **Assess confidence honestly** — If you're not sure, say "uncertain".

## Verdicts

- **true-positive** — Real AND exploitable. You can describe a concrete attack.
- **false-positive** — Not exploitable. Name the specific mitigation.
- **fixed** — Was real but has been patched. Cite the change.
- **uncertain** — Can't determine. Explain what's ambiguous.

## Output Format

\`\`\`json
[
  {
    "filePath": "exact/path/to/file.ts",
    "title": "exact title from the finding",
    "verdict": "true-positive",
    "reasoning": "Detailed explanation (5-10 sentences). Show your work."
  }
]
\`\`\`

**Include \`filePath\` for every verdict.** \`adjustedSeverity\` is optional — set it when severity should change.`;

  return { prompt, totalFindings };
}

// ---------------------------------------------------------------------------
// GitHub Copilot API client
// ---------------------------------------------------------------------------

interface CopilotChatResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

/**
 * Resolve a GitHub token for the Copilot API.
 *
 * Priority:
 *   1. GH_COPILOT_TOKEN — a token with the `copilot` scope set explicitly
 *   2. GITHUB_TOKEN — standard GitHub token (CI / PAT / OAuth)
 *   3. `gh auth token` — reuse the interactive session from `gh auth login`
 */
export function resolveGitHubToken(): string {
  const explicit = process.env.GH_COPILOT_TOKEN ?? process.env.GITHUB_TOKEN;
  if (explicit) return explicit;

  // Try the GitHub CLI as a subscription-auth fallback.  spawnSync is safe
  // here: `gh` is a well-known binary, and the argument list has no
  // user-controlled values.
  const result = spawnSync("gh", ["auth", "token"], {
    encoding: "utf-8",
    timeout: 5_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const token = (result.stdout ?? "").trim();
  if (token) return token;

  throw new Error(
    "GitHub Copilot authentication missing.\n\n" +
      "  Option 1 — GitHub CLI (recommended for local development):\n" +
      "    Install: https://cli.github.com/\n" +
      "    Then:    gh auth login\n" +
      "             gh auth refresh --scopes copilot\n\n" +
      "  Option 2 — Set in .env.local:\n" +
      "    GH_COPILOT_TOKEN=github_pat_…   (PAT with copilot scope)\n" +
      "    or GITHUB_TOKEN=ghp_…\n\n" +
      "  See docs/github-copilot-acp.md for the full setup guide.",
  );
}

async function callCopilotApi(params: {
  model: string;
  prompt: string;
  baseUrl: string;
  token: string;
}): Promise<string> {
  const { model, prompt, baseUrl, token } = params;
  const url = `${baseUrl}/chat/completions`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Copilot-Integration-Id": "deepsec",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`GitHub Copilot API ${response.status}: ${body.slice(0, 500)}`);
  }

  const data = (await response.json()) as CopilotChatResponse;
  return data.choices[0]?.message?.content ?? "";
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export class AcpAgentPlugin implements AgentPlugin {
  type = "acp";

  async *investigate(params: InvestigateParams): AsyncGenerator<AgentProgress, InvestigateOutput> {
    const { batch, projectRoot, promptTemplate, projectInfo, config } = params;
    const model = (config.model as string) ?? DEFAULT_MODEL;
    const baseUrl = (config.baseUrl as string) ?? DEFAULT_BASE_URL;

    yield {
      type: "started",
      message: `Investigating ${batch.length} file(s) with GitHub Copilot via ACP (${model})`,
    };

    let token: string;
    try {
      token = resolveGitHubToken();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: "error", message: msg };
      return {
        results: batch.map((r) => ({ filePath: r.filePath, findings: [] })),
        meta: { durationMs: 0 },
      };
    }

    const prompt = buildAcpInvestigatePrompt({ promptTemplate, projectInfo, batch, projectRoot });
    const startTime = Date.now();
    let resultText = "";
    let lastError = "";
    let sdkMeta: Partial<BatchMeta> = {};

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        yield {
          type: "thinking" as const,
          message: `Retrying after transient error (attempt ${attempt}/${MAX_ATTEMPTS}): ${lastError.slice(0, 200)}`,
        };
        resultText = "";
        lastError = "";
      }

      try {
        yield {
          type: "thinking" as const,
          message: `Sending ${batch.length} file(s) to GitHub Copilot (${model})…`,
        };

        resultText = await callCopilotApi({ model, prompt, baseUrl, token });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        yield {
          type: "error" as const,
          message: `GitHub Copilot API error: ${lastError.slice(0, 300)}`,
        };
      }

      if (resultText) break;
      if (attempt >= MAX_ATTEMPTS || !isTransientError(lastError)) break;
      await backoff(attempt);
    }

    const durationMs = Date.now() - startTime;
    sdkMeta = { durationMs };

    yield {
      type: "complete",
      message: `Investigation complete (${(durationMs / 1000).toFixed(1)}s, ${batch.length} file(s), ${model})`,
    };

    return {
      results: parseInvestigateResults(resultText, batch),
      meta: sdkMeta as BatchMeta,
    };
  }

  async *revalidate(params: RevalidateParams): AsyncGenerator<AgentProgress, RevalidateOutput> {
    const { batch, projectRoot, projectInfo, config, force = false } = params;
    const model = (config.model as string) ?? DEFAULT_MODEL;
    const baseUrl = (config.baseUrl as string) ?? DEFAULT_BASE_URL;

    const { prompt, totalFindings } = buildAcpRevalidatePrompt({
      batch,
      projectRoot,
      projectInfo,
      force,
    });

    yield {
      type: "started",
      message: `Revalidating ${totalFindings} finding(s) across ${batch.length} file(s) with GitHub Copilot (${model})`,
    };

    let token: string;
    try {
      token = resolveGitHubToken();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: "error", message: msg };
      return { verdicts: [], meta: { durationMs: 0 } };
    }

    const startTime = Date.now();
    let resultText = "";
    let lastError = "";

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        yield {
          type: "thinking" as const,
          message: `Retrying revalidation after transient error (attempt ${attempt}/${MAX_ATTEMPTS}): ${lastError.slice(0, 200)}`,
        };
        resultText = "";
        lastError = "";
      }

      try {
        yield {
          type: "thinking" as const,
          message: `Sending ${totalFindings} finding(s) to GitHub Copilot (${model})…`,
        };

        resultText = await callCopilotApi({ model, prompt, baseUrl, token });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        yield {
          type: "error" as const,
          message: `GitHub Copilot API error: ${lastError.slice(0, 300)}`,
        };
      }

      if (resultText) break;
      if (attempt >= MAX_ATTEMPTS || !isTransientError(lastError)) break;
      await backoff(attempt);
    }

    const durationMs = Date.now() - startTime;
    const verdicts = parseRevalidateVerdicts(resultText);

    yield {
      type: "complete",
      message: `Revalidation complete (${(durationMs / 1000).toFixed(1)}s, ${verdicts.length} verdict(s))`,
    };

    return {
      verdicts,
      meta: { durationMs },
    };
  }
}
