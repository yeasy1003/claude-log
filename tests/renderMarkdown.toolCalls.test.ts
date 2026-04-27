import { describe, expect, test } from "vitest";
import { summarizeToolInput } from "../src/core/renderMarkdown.ts";

describe("summarizeToolInput", () => {
  test("Bash uses input.command", () => {
    expect(summarizeToolInput("Bash", { command: "git status" })).toBe("git status");
  });
  test("Read uses input.file_path", () => {
    expect(summarizeToolInput("Read", { file_path: "src/foo.ts" })).toBe("src/foo.ts");
  });
  test("Edit uses input.file_path", () => {
    expect(summarizeToolInput("Edit", { file_path: "src/foo.ts" })).toBe("src/foo.ts");
  });
  test("Write uses input.file_path", () => {
    expect(summarizeToolInput("Write", { file_path: "src/foo.ts" })).toBe("src/foo.ts");
  });
  test("Grep uses input.pattern", () => {
    expect(summarizeToolInput("Grep", { pattern: "foo.*bar" })).toBe("foo.*bar");
  });
  test("Skill uses skill name (and args if present)", () => {
    expect(summarizeToolInput("Skill", { skill: "superpowers:brainstorming" })).toBe(
      "superpowers:brainstorming",
    );
    expect(summarizeToolInput("Skill", { skill: "loop", args: "5m /foo" })).toBe("loop 5m /foo");
  });
  test("Agent uses subagent_type, falls back to description", () => {
    expect(summarizeToolInput("Agent", { subagent_type: "Explore" })).toBe("Explore");
    expect(summarizeToolInput("Agent", { description: "audit branch" })).toBe("audit branch");
  });
  test("WebFetch uses url; WebSearch uses query", () => {
    expect(summarizeToolInput("WebFetch", { url: "https://x" })).toBe("https://x");
    expect(summarizeToolInput("WebSearch", { query: "hello" })).toBe("hello");
  });
  test("unknown tool falls back to JSON.stringify, capped at 200 chars", () => {
    const big = { stuff: "y".repeat(500) };
    const summary = summarizeToolInput("Unknown", big);
    expect(summary.length).toBe(203); // 200 + "..."
    expect(summary.endsWith("...")).toBe(true);
  });
  test("known tool with missing field falls back to JSON summary", () => {
    expect(summarizeToolInput("Bash", { not_command: "x" })).toBe('{"not_command":"x"}');
  });
  test("input summary always capped at 200 characters", () => {
    const longCmd = `echo ${"a".repeat(500)}`;
    const summary = summarizeToolInput("Bash", { command: longCmd });
    expect(summary.length).toBe(203);
    expect(summary.endsWith("...")).toBe(true);
  });
});
