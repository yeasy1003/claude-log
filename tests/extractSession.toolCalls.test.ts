import { describe, expect, test } from "vitest";
import { extractSession } from "../src/core/extractSession.ts";

const baseInput = {
  projectId: "proj-1",
  sourceFile: "/tmp/session.jsonl",
  sourceMtimeMs: 1700000000000,
};

const userText = (text: string) => ({
  type: "user",
  isSidechain: false,
  message: { role: "user", content: text },
});

const assistantWithTools = (
  tools: Array<{ id: string; name: string; input: unknown }>,
  text: string | null = null,
) => ({
  type: "assistant",
  isSidechain: false,
  message: {
    role: "assistant",
    content: [
      ...(text === null ? [] : [{ type: "text", text }]),
      ...tools.map((t) => ({ type: "tool_use", ...t })),
    ],
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  },
});

const userToolResults = (
  results: Array<{ tool_use_id: string; content: unknown; is_error?: boolean }>,
) => ({
  type: "user",
  isSidechain: false,
  message: {
    role: "user",
    content: results.map((r) => ({ type: "tool_result", ...r })),
  },
});

describe("extractSession tool calls", () => {
  test("default: toolCalls field is absent on each turn", () => {
    const entries = [
      userText("hi"),
      assistantWithTools([{ id: "t1", name: "Bash", input: { command: "ls" } }], "ok"),
      userToolResults([{ tool_use_id: "t1", content: "a\nb\n" }]),
    ];
    const result = extractSession({ ...baseInput, entries });
    expect(result.turns).toHaveLength(1);
    const turn = result.turns[0];
    expect(turn).toBeDefined();
    if (turn === undefined) return;
    expect("toolCalls" in turn).toBe(false);
  });

  test("captureToolCalls=true: pairs tool_use with tool_result by id", () => {
    const entries = [
      userText("ask"),
      assistantWithTools([{ id: "t1", name: "Bash", input: { command: "ls" } }], "thinking"),
      userToolResults([{ tool_use_id: "t1", content: "file1\nfile2" }]),
      userText("next"),
    ];
    const result = extractSession({
      ...baseInput,
      entries,
      options: { captureToolCalls: true },
    });
    expect(result.turns[0]?.toolCalls).toEqual([
      {
        id: "t1",
        name: "Bash",
        input: { command: "ls" },
        output: "file1\nfile2",
        isError: false,
      },
    ]);
    expect(result.turns[1]?.toolCalls).toEqual([]);
  });

  test("pairs across non-user entries inserted between tool_use and tool_result", () => {
    const entries = [
      userText("ask"),
      assistantWithTools([{ id: "t1", name: "Read", input: { file_path: "f.ts" } }]),
      { type: "last-prompt", payload: "irrelevant" },
      userToolResults([{ tool_use_id: "t1", content: "contents" }]),
    ];
    const result = extractSession({
      ...baseInput,
      entries,
      options: { captureToolCalls: true },
    });
    expect(result.turns[0]?.toolCalls?.[0]?.output).toBe("contents");
  });

  test("multiple tool_uses in one assistant entry, results returned out of order", () => {
    const entries = [
      userText("ask"),
      assistantWithTools([
        { id: "a", name: "Bash", input: { command: "1" } },
        { id: "b", name: "Bash", input: { command: "2" } },
        { id: "c", name: "Bash", input: { command: "3" } },
      ]),
      userToolResults([
        { tool_use_id: "c", content: "out-c" },
        { tool_use_id: "a", content: "out-a" },
        { tool_use_id: "b", content: "out-b" },
      ]),
    ];
    const result = extractSession({
      ...baseInput,
      entries,
      options: { captureToolCalls: true },
    });
    const turn = result.turns[0];
    expect(turn).toBeDefined();
    expect(turn?.toolCalls).toBeDefined();
    const calls = turn?.toolCalls || [];
    expect(calls.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(calls.map((c) => c.output)).toEqual(["out-a", "out-b", "out-c"]);
  });

  test("tool_use before any user query is dropped", () => {
    const entries = [
      assistantWithTools([{ id: "t1", name: "Bash", input: { command: "init" } }]),
      userText("hi"),
    ];
    const result = extractSession({
      ...baseInput,
      entries,
      options: { captureToolCalls: true },
    });
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]?.toolCalls).toEqual([]);
  });

  test("unmatched tool_use leaves output null", () => {
    const entries = [
      userText("ask"),
      assistantWithTools([{ id: "t1", name: "Bash", input: { command: "x" } }]),
    ];
    const result = extractSession({
      ...baseInput,
      entries,
      options: { captureToolCalls: true },
    });
    expect(result.turns[0]?.toolCalls?.[0]?.output).toBeNull();
  });

  test("tool_result content array with text + image is joined; image becomes [image omitted]", () => {
    const entries = [
      userText("ask"),
      assistantWithTools([{ id: "t1", name: "Read", input: {} }]),
      userToolResults([
        {
          tool_use_id: "t1",
          content: [
            { type: "text", text: "line 1" },
            { type: "image" },
            { type: "text", text: "line 3" },
          ],
        },
      ]),
    ];
    const result = extractSession({
      ...baseInput,
      entries,
      options: { captureToolCalls: true },
    });
    expect(result.turns[0]?.toolCalls?.[0]?.output).toBe("line 1\n[image omitted]\nline 3");
  });

  test("is_error true is propagated; missing is_error defaults to false", () => {
    const entries = [
      userText("ask"),
      assistantWithTools([
        { id: "ok", name: "Bash", input: { command: "ok" } },
        { id: "bad", name: "Bash", input: { command: "fail" } },
      ]),
      userToolResults([
        { tool_use_id: "ok", content: "fine" },
        { tool_use_id: "bad", content: "boom", is_error: true },
      ]),
    ];
    const result = extractSession({
      ...baseInput,
      entries,
      options: { captureToolCalls: true },
    });
    expect(result.turns[0]?.toolCalls?.[0]?.isError).toBe(false);
    expect(result.turns[0]?.toolCalls?.[1]?.isError).toBe(true);
  });

  test("truncates output to limit and appends '...'", () => {
    const longOutput = "x".repeat(5000);
    const entries = [
      userText("ask"),
      assistantWithTools([{ id: "t1", name: "Bash", input: { command: "spam" } }]),
      userToolResults([{ tool_use_id: "t1", content: longOutput }]),
    ];
    const result = extractSession({
      ...baseInput,
      entries,
      options: { captureToolCalls: true, toolOutputLimit: 100 },
    });
    expect(result.turns[0]?.toolCalls?.[0]?.output).toBe(`${"x".repeat(100)}...`);
  });

  test("limit=0 disables truncation", () => {
    const longOutput = "x".repeat(5000);
    const entries = [
      userText("ask"),
      assistantWithTools([{ id: "t1", name: "Bash", input: {} }]),
      userToolResults([{ tool_use_id: "t1", content: longOutput }]),
    ];
    const result = extractSession({
      ...baseInput,
      entries,
      options: { captureToolCalls: true, toolOutputLimit: 0 },
    });
    expect(result.turns[0]?.toolCalls?.[0]?.output).toBe(longOutput);
  });

  test("sidechain entries with tool_use are excluded", () => {
    const entries = [
      userText("ask"),
      {
        type: "assistant",
        isSidechain: true,
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "side", name: "Bash", input: { command: "x" } }],
        },
      },
      assistantWithTools([{ id: "main", name: "Bash", input: { command: "y" } }]),
      userToolResults([{ tool_use_id: "main", content: "ok" }]),
    ];
    const result = extractSession({
      ...baseInput,
      entries,
      options: { captureToolCalls: true },
    });
    const ids = result.turns[0]?.toolCalls?.map((c) => c.id);
    expect(ids).toEqual(["main"]);
  });
});
