import { describe, expect, test } from "vitest";
import { resolveSession } from "../src/core/resolveSession.ts";
import type { SessionSummary } from "../src/core/types.ts";

const mk = (id: string): SessionSummary => ({
  sessionId: id,
  projectId: "p",
  cwd: null,
  gitBranch: null,
  startedAt: null,
  endedAt: null,
  messageCount: 0,
  turns: [],
  skillsUsed: [],
  agentsUsed: [],
  toolCounts: {},
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadTokens: 0,
  totalCacheCreationTokens: 0,
  sourceFile: "",
  sourceMtimeMs: 0,
});

describe("resolveSession", () => {
  test("returns ok on exact id match", () => {
    const all = [mk("abc123"), mk("def456")];
    const r = resolveSession(all, "abc123");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.session.sessionId).toBe("abc123");
  });

  test("returns ok when prefix matches exactly one", () => {
    const all = [mk("abc123"), mk("def456")];
    const r = resolveSession(all, "abc");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.session.sessionId).toBe("abc123");
  });

  test("returns ambiguous when prefix matches multiple", () => {
    const all = [mk("abc123"), mk("abc999"), mk("def456")];
    const r = resolveSession(all, "abc");
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") expect(r.candidates).toHaveLength(2);
  });

  test("returns none when nothing matches", () => {
    const all = [mk("abc123")];
    const r = resolveSession(all, "xyz");
    expect(r.kind).toBe("none");
  });

  test("exact match wins over multiple prefix candidates", () => {
    const all = [mk("abc"), mk("abcdef"), mk("abcxyz")];
    const r = resolveSession(all, "abc");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.session.sessionId).toBe("abc");
  });
});
