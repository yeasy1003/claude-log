import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseSince, resolveClaudeDir } from "../src/core/config.ts";

describe("parseSince", () => {
  test("returns null for undefined", () => {
    expect(parseSince(undefined)).toBeNull();
  });

  test("parses relative days", () => {
    const before = Date.now() - 7 * 86400000;
    const v = parseSince("7d");
    expect(v).not.toBeNull();
    if (v !== null) expect(v).toBeGreaterThanOrEqual(before - 1000);
  });

  test("parses relative hours", () => {
    const before = Date.now() - 24 * 3600000;
    const v = parseSince("24h");
    expect(v).not.toBeNull();
    if (v !== null) expect(v).toBeGreaterThanOrEqual(before - 1000);
  });

  test("parses relative minutes", () => {
    const before = Date.now() - 30 * 60000;
    const v = parseSince("30m");
    expect(v).not.toBeNull();
    if (v !== null) expect(v).toBeGreaterThanOrEqual(before - 1000);
  });

  test("parses ISO date", () => {
    const v = parseSince("2026-04-01T00:00:00Z");
    expect(v).toBe(new Date("2026-04-01T00:00:00Z").getTime());
  });

  test("throws on invalid value", () => {
    expect(() => parseSince("lol")).toThrow();
  });
});

describe("resolveClaudeDir", () => {
  const originalEnv = process.env.CLAUDE_CONFIG_DIR;
  beforeEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalEnv;
  });

  test("uses explicit override first", () => {
    process.env.CLAUDE_CONFIG_DIR = "/env/path";
    expect(resolveClaudeDir("/override")).toBe("/override");
  });

  test("falls back to env var", () => {
    process.env.CLAUDE_CONFIG_DIR = "/env/path";
    expect(resolveClaudeDir()).toBe("/env/path");
  });

  test("falls back to ~/.claude when nothing set", () => {
    const v = resolveClaudeDir();
    expect(v.endsWith("/.claude")).toBe(true);
  });
});
