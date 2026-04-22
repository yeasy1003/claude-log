import { describe, expect, test } from "vitest";
import { extractSession } from "../src/core/extractSession.ts";

const baseInput = {
  projectId: "proj-1",
  sourceFile: "/tmp/session.jsonl",
  sourceMtimeMs: 1700000000000,
};

describe("extractSession", () => {
  test("returns empty summary for no entries", () => {
    const result = extractSession({ ...baseInput, entries: [] });
    expect(result.turns).toEqual([]);
    expect(result.skillsUsed).toEqual([]);
    expect(result.agentsUsed).toEqual([]);
    expect(result.toolCounts).toEqual({});
    expect(result.sessionId).toBe("");
    expect(result.messageCount).toBe(0);
  });

  test("extracts user queries from string content into turns", () => {
    const entries = [
      {
        type: "user",
        sessionId: "s1",
        cwd: "/repo",
        gitBranch: "main",
        timestamp: "2026-04-21T10:00:00Z",
        isSidechain: false,
        message: { role: "user", content: "hello claude" },
      },
    ];
    const result = extractSession({ ...baseInput, entries });
    expect(result.turns).toEqual([{ user: "hello claude", assistant: null }]);
    expect(result.sessionId).toBe("s1");
    expect(result.cwd).toBe("/repo");
    expect(result.gitBranch).toBe("main");
    expect(result.startedAt).toBe("2026-04-21T10:00:00Z");
    expect(result.endedAt).toBe("2026-04-21T10:00:00Z");
  });

  test("skips tool_result-only user entries", () => {
    const entries = [
      {
        type: "user",
        isSidechain: false,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "file contents" }],
        },
      },
    ];
    const result = extractSession({ ...baseInput, entries });
    expect(result.turns).toEqual([]);
  });

  test("skips sidechain entries", () => {
    const entries = [
      {
        type: "user",
        isSidechain: true,
        message: { role: "user", content: "subagent prompt" },
      },
    ];
    const result = extractSession({ ...baseInput, entries });
    expect(result.turns).toEqual([]);
  });

  test("pairs user query with its last assistant text in the same turn", () => {
    const entries = [
      { type: "user", isSidechain: false, message: { role: "user", content: "do the thing" } },
      {
        type: "assistant",
        isSidechain: false,
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "thinking out loud" },
            { type: "tool_use", id: "t1", name: "Read", input: {} },
          ],
        },
      },
      {
        type: "user",
        isSidechain: false,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
        },
      },
      {
        type: "assistant",
        isSidechain: false,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "final answer for turn 1" }],
        },
      },
      { type: "user", isSidechain: false, message: { role: "user", content: "follow up" } },
      {
        type: "assistant",
        isSidechain: false,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "final answer for turn 2" }],
        },
      },
    ];
    const result = extractSession({ ...baseInput, entries });
    expect(result.turns).toEqual([
      { user: "do the thing", assistant: "final answer for turn 1" },
      { user: "follow up", assistant: "final answer for turn 2" },
    ]);
  });

  test("records turn with null assistant when the turn has only tool calls", () => {
    const entries = [
      { type: "user", isSidechain: false, message: { role: "user", content: "read it" } },
      {
        type: "assistant",
        isSidechain: false,
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }],
        },
      },
    ];
    const result = extractSession({ ...baseInput, entries });
    expect(result.turns).toEqual([{ user: "read it", assistant: null }]);
  });

  test("discards assistant text that appears before any user query", () => {
    const entries = [
      {
        type: "assistant",
        isSidechain: false,
        message: { role: "assistant", content: [{ type: "text", text: "orphan preamble" }] },
      },
      { type: "user", isSidechain: false, message: { role: "user", content: "hello" } },
      {
        type: "assistant",
        isSidechain: false,
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      },
    ];
    const result = extractSession({ ...baseInput, entries });
    expect(result.turns).toEqual([{ user: "hello", assistant: "hi" }]);
  });

  test("aggregates Skill invocations and tool counts", () => {
    const entries = [
      {
        type: "assistant",
        isSidechain: false,
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "a", name: "Read", input: {} },
            { type: "tool_use", id: "b", name: "Read", input: {} },
            {
              type: "tool_use",
              id: "c",
              name: "Skill",
              input: { skill: "lark-mail", args: "send report" },
            },
            { type: "tool_use", id: "d", name: "Skill", input: { skill: "update-config" } },
          ],
        },
      },
    ];
    const result = extractSession({ ...baseInput, entries });
    expect(result.toolCounts).toEqual({ Read: 2, Skill: 2 });
    expect(result.skillsUsed).toEqual([
      { name: "lark-mail", args: "send report" },
      { name: "update-config", args: null },
    ]);
  });

  test("captures Agent tool invocations (with and without subagent_type)", () => {
    const entries = [
      {
        type: "assistant",
        isSidechain: false,
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "a1",
              name: "Agent",
              input: {
                description: "Explore repo",
                subagent_type: "Explore",
                prompt: "...",
              },
            },
            {
              type: "tool_use",
              id: "a2",
              name: "Agent",
              input: { description: "Summarize changes", prompt: "..." },
            },
          ],
        },
      },
    ];
    const result = extractSession({ ...baseInput, entries });
    expect(result.agentsUsed).toEqual([
      { subagent_type: "Explore", description: "Explore repo" },
      { subagent_type: "general-purpose", description: "Summarize changes" },
    ]);
    expect(result.toolCounts).toEqual({ Agent: 2 });
  });

  test("strips system-reminder tags but preserves actual question", () => {
    const entries = [
      {
        type: "user",
        isSidechain: false,
        message: {
          role: "user",
          content: "<system-reminder>stale hint</system-reminder>\nactual question here",
        },
      },
    ];
    const result = extractSession({ ...baseInput, entries });
    expect(result.turns.map((t) => t.user)).toEqual(["actual question here"]);
  });

  test("extracts bash-input as `! <cmd>`", () => {
    const entries = [
      {
        type: "user",
        isSidechain: false,
        message: { role: "user", content: "<bash-input>git status</bash-input>" },
      },
    ];
    const result = extractSession({ ...baseInput, entries });
    expect(result.turns.map((t) => t.user)).toEqual(["! git status"]);
  });

  test("drops bash-stdout/bash-stderr echo messages entirely", () => {
    const entries = [
      {
        type: "user",
        isSidechain: false,
        message: { role: "user", content: "<bash-input>ls</bash-input>" },
      },
      {
        type: "user",
        isSidechain: false,
        message: {
          role: "user",
          content: "<bash-stdout>file1\nfile2\n</bash-stdout><bash-stderr></bash-stderr>",
        },
      },
      {
        type: "user",
        isSidechain: false,
        message: { role: "user", content: "next question" },
      },
    ];
    const result = extractSession({ ...baseInput, entries });
    expect(result.turns.map((t) => t.user)).toEqual(["! ls", "next question"]);
  });

  test("extracts slash command as its name", () => {
    const entries = [
      {
        type: "user",
        isSidechain: false,
        message: {
          role: "user",
          content:
            "<command-message>find-skills</command-message> <command-name>/find-skills</command-name>",
        },
      },
    ];
    const result = extractSession({ ...baseInput, entries });
    expect(result.turns.map((t) => t.user)).toEqual(["/find-skills"]);
  });

  test("extracts slash command with args", () => {
    const entries = [
      {
        type: "user",
        isSidechain: false,
        message: {
          role: "user",
          content:
            "<command-name>/review</command-name><command-args>PR 123</command-args>",
        },
      },
    ];
    const result = extractSession({ ...baseInput, entries });
    expect(result.turns.map((t) => t.user)).toEqual(["/review PR 123"]);
  });

  test("drops local-command-stdout and task-notification echoes", () => {
    const entries = [
      {
        type: "user",
        isSidechain: false,
        message: {
          role: "user",
          content: "<local-command-stdout>Set model to Opus</local-command-stdout>",
        },
      },
      {
        type: "user",
        isSidechain: false,
        message: {
          role: "user",
          content:
            "<task-notification><task-id>x</task-id><status>completed</status></task-notification>",
        },
      },
    ];
    const result = extractSession({ ...baseInput, entries });
    expect(result.turns).toEqual([]);
  });

  test("filters out synthetic interrupt user messages", () => {
    const entries = [
      { type: "user", isSidechain: false, message: { role: "user", content: "real question" } },
      {
        type: "user",
        isSidechain: false,
        message: { role: "user", content: "[Request interrupted by user for tool use]" },
      },
      { type: "user", isSidechain: false, message: { role: "user", content: "follow up" } },
    ];
    const result = extractSession({ ...baseInput, entries });
    expect(result.turns.map((t) => t.user)).toEqual(["real question", "follow up"]);
  });

  test("accumulates tokens across assistant entries", () => {
    const entries = [
      { type: "user", isSidechain: false, message: { role: "user", content: "q" } },
      {
        type: "assistant",
        isSidechain: false,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "x" }],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 1000,
            cache_creation_input_tokens: 500,
          },
        },
      },
      {
        type: "assistant",
        isSidechain: false,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "y" }],
          usage: {
            input_tokens: 200,
            output_tokens: 50,
            cache_read_input_tokens: 1500,
            cache_creation_input_tokens: 0,
          },
        },
      },
    ];
    const result = extractSession({ ...baseInput, entries });
    expect(result.totalInputTokens).toBe(300);
    expect(result.totalOutputTokens).toBe(70);
    expect(result.totalCacheReadTokens).toBe(2500);
    expect(result.totalCacheCreationTokens).toBe(500);
  });
});
