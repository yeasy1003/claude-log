import { describe, expect, test } from "vitest";
import { renderMarkdown, summarizeToolInput } from "../src/core/renderMarkdown.ts";
import type { SessionSummary } from "../src/core/types.ts";

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

const baseSession = (turns: SessionSummary["turns"]): SessionSummary => ({
  sessionId: "s1",
  projectId: "p1",
  cwd: null,
  gitBranch: null,
  startedAt: null,
  endedAt: null,
  messageCount: 0,
  turns,
  skillsUsed: [],
  agentsUsed: [],
  toolCounts: {},
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadTokens: 0,
  totalCacheCreationTokens: 0,
  sourceFile: "/tmp/x.jsonl",
  sourceMtimeMs: 0,
});

describe("renderMarkdown tool calls", () => {
  test("turn without toolCalls field renders no Tool Calls subsection", () => {
    const md = renderMarkdown(baseSession([{ user: "hi", assistant: "ok" }]), "interleaved");
    expect(md).not.toContain("Tool Calls");
  });

  test("turn with empty toolCalls array renders no subsection", () => {
    const md = renderMarkdown(
      baseSession([{ user: "hi", assistant: "ok", toolCalls: [] }]),
      "interleaved",
    );
    expect(md).not.toContain("Tool Calls");
  });

  test("interleaved: Q -> Tool Calls -> A in correct order, numbered", () => {
    const md = renderMarkdown(
      baseSession([
        {
          user: "ask",
          assistant: "done",
          toolCalls: [
            {
              id: "t1",
              name: "Bash",
              input: { command: "ls" },
              output: "file1",
              isError: false,
            },
            {
              id: "t2",
              name: "Read",
              input: { file_path: "src/foo.ts" },
              output: null,
              isError: false,
            },
          ],
        },
      ]),
      "interleaved",
    );
    expect(md).toContain("### Q1");
    expect(md).toContain("### Tool Calls (Q1)");
    expect(md).toContain("### A1");
    expect(md.indexOf("### Q1")).toBeLessThan(md.indexOf("### Tool Calls (Q1)"));
    expect(md.indexOf("### Tool Calls (Q1)")).toBeLessThan(md.indexOf("### A1"));
    expect(md).toMatch(/1\. \*\*Bash\*\* — `ls`/);
    expect(md).toMatch(/2\. \*\*Read\*\* — `src\/foo\.ts`/);
    expect(md).toContain("_(no output captured)_");
  });

  test("error tool call shows [error] marker", () => {
    const md = renderMarkdown(
      baseSession([
        {
          user: "x",
          assistant: null,
          toolCalls: [
            {
              id: "t1",
              name: "Bash",
              input: { command: "fail" },
              output: "boom",
              isError: true,
            },
          ],
        },
      ]),
      "interleaved",
    );
    expect(md).toMatch(/1\. \*\*Bash\*\* \[error\] — `fail`/);
  });

  test("dynamic fence: 3 backticks for plain output", () => {
    const md = renderMarkdown(
      baseSession([
        {
          user: "x",
          assistant: null,
          toolCalls: [
            { id: "t1", name: "Bash", input: { command: "x" }, output: "plain", isError: false },
          ],
        },
      ]),
      "interleaved",
    );
    expect(md).toMatch(/```\nplain\n```/);
  });

  test("dynamic fence: bumps to 4 backticks when output contains ```", () => {
    const md = renderMarkdown(
      baseSession([
        {
          user: "x",
          assistant: null,
          toolCalls: [
            {
              id: "t1",
              name: "Bash",
              input: { command: "x" },
              output: "before\n```\nafter",
              isError: false,
            },
          ],
        },
      ]),
      "interleaved",
    );
    expect(md).toContain("````\nbefore\n```\nafter\n````");
  });

  test("dynamic fence: bumps to 5 backticks when output contains ````", () => {
    const md = renderMarkdown(
      baseSession([
        {
          user: "x",
          assistant: null,
          toolCalls: [
            {
              id: "t1",
              name: "Bash",
              input: { command: "x" },
              output: "````",
              isError: false,
            },
          ],
        },
      ]),
      "interleaved",
    );
    expect(md).toContain("`````\n````\n`````");
  });

  test("sectioned format renders ## Tool Calls grouped by Q", () => {
    const md = renderMarkdown(
      baseSession([
        {
          user: "first",
          assistant: "ok",
          toolCalls: [
            { id: "t1", name: "Bash", input: { command: "a" }, output: "A", isError: false },
          ],
        },
        {
          user: "second",
          assistant: "ok",
          toolCalls: [
            { id: "t2", name: "Bash", input: { command: "b" }, output: "B", isError: false },
          ],
        },
      ]),
      "sectioned",
    );
    expect(md).toContain("## Tool Calls");
    expect(md).toContain("### Q1");
    expect(md).toContain("### Q2");
    const toolCallsAt = md.indexOf("## Tool Calls");
    const conclusionsAt = md.indexOf("## Assistant Conclusions");
    const toolsUsedAt = md.indexOf("## Tools Used");
    expect(conclusionsAt).toBeLessThan(toolCallsAt);
    expect(toolCallsAt).toBeLessThan(toolsUsedAt);
  });

  test("sectioned: section is omitted entirely when no turn has toolCalls", () => {
    const md = renderMarkdown(baseSession([{ user: "first", assistant: "ok" }]), "sectioned");
    expect(md).not.toContain("## Tool Calls");
  });
});
