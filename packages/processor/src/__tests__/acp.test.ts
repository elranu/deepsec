import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpAgentPlugin, DEFAULT_MODEL, resolveGitHubToken } from "../agents/acp.js";

// ---------------------------------------------------------------------------
// resolveGitHubToken
// ---------------------------------------------------------------------------

describe("resolveGitHubToken", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {
      GH_COPILOT_TOKEN: process.env.GH_COPILOT_TOKEN,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    };
    delete process.env.GH_COPILOT_TOKEN;
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("prefers GH_COPILOT_TOKEN over GITHUB_TOKEN", () => {
    process.env.GH_COPILOT_TOKEN = "copilot-tok";
    process.env.GITHUB_TOKEN = "gh-tok";
    expect(resolveGitHubToken()).toBe("copilot-tok");
  });

  it("falls back to GITHUB_TOKEN when GH_COPILOT_TOKEN is absent", () => {
    process.env.GITHUB_TOKEN = "ghp_test";
    expect(resolveGitHubToken()).toBe("ghp_test");
  });

  it("throws a descriptive error when no token and gh CLI unavailable", () => {
    // PATH is deliberately empty in CI so spawnSync('gh', ...) returns no output
    const saved_PATH = process.env.PATH;
    process.env.PATH = "";
    try {
      expect(() => resolveGitHubToken()).toThrow(/GH_COPILOT_TOKEN/);
      expect(() => resolveGitHubToken()).toThrow(/gh auth login/);
      expect(() => resolveGitHubToken()).toThrow(/github-copilot-acp\.md/);
    } finally {
      process.env.PATH = saved_PATH;
    }
  });
});

// ---------------------------------------------------------------------------
// AcpAgentPlugin shape
// ---------------------------------------------------------------------------

describe("AcpAgentPlugin", () => {
  it("has type 'acp'", () => {
    const plugin = new AcpAgentPlugin();
    expect(plugin.type).toBe("acp");
  });

  it("exports DEFAULT_MODEL", () => {
    expect(typeof DEFAULT_MODEL).toBe("string");
    expect(DEFAULT_MODEL.length).toBeGreaterThan(0);
  });

  it("investigate yields started event and returns empty results when no token", async () => {
    // Remove all GitHub tokens so the plugin emits an error event and short-circuits
    const savedCopilot = process.env.GH_COPILOT_TOKEN;
    const savedGithub = process.env.GITHUB_TOKEN;
    const savedPath = process.env.PATH;
    delete process.env.GH_COPILOT_TOKEN;
    delete process.env.GITHUB_TOKEN;
    process.env.PATH = "";

    try {
      const plugin = new AcpAgentPlugin();
      const gen = plugin.investigate({
        batch: [],
        projectRoot: "/tmp",
        promptTemplate: "test",
        projectInfo: "",
        config: {},
      });

      const events: { type: string; message: string }[] = [];
      let result: { results: unknown[]; meta: unknown } | undefined;

      // Drain the generator
      while (true) {
        const next = await gen.next();
        if (next.done) {
          result = next.value as { results: unknown[]; meta: unknown };
          break;
        }
        events.push(next.value as { type: string; message: string });
      }

      expect(events.some((e) => e.type === "started")).toBe(true);
      expect(events.some((e) => e.type === "error")).toBe(true);
      expect(result?.results).toEqual([]);
    } finally {
      if (savedCopilot !== undefined) process.env.GH_COPILOT_TOKEN = savedCopilot;
      if (savedGithub !== undefined) process.env.GITHUB_TOKEN = savedGithub;
      process.env.PATH = savedPath;
    }
  });

  it("revalidate yields started event and returns empty verdicts when no token", async () => {
    const savedCopilot = process.env.GH_COPILOT_TOKEN;
    const savedGithub = process.env.GITHUB_TOKEN;
    const savedPath = process.env.PATH;
    delete process.env.GH_COPILOT_TOKEN;
    delete process.env.GITHUB_TOKEN;
    process.env.PATH = "";

    try {
      const plugin = new AcpAgentPlugin();
      const gen = plugin.revalidate({
        batch: [],
        projectRoot: "/tmp",
        projectInfo: "",
        config: {},
        force: false,
      });

      const events: { type: string }[] = [];
      let result: { verdicts: unknown[] } | undefined;

      while (true) {
        const next = await gen.next();
        if (next.done) {
          result = next.value as { verdicts: unknown[] };
          break;
        }
        events.push(next.value as { type: string });
      }

      expect(events.some((e) => e.type === "started")).toBe(true);
      expect(result?.verdicts).toEqual([]);
    } finally {
      if (savedCopilot !== undefined) process.env.GH_COPILOT_TOKEN = savedCopilot;
      if (savedGithub !== undefined) process.env.GITHUB_TOKEN = savedGithub;
      process.env.PATH = savedPath;
    }
  });
});
