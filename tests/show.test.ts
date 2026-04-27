import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { runShow } from "../src/commands/show.ts";

let tmp: string;
// biome-ignore lint/suspicious/noExplicitAny: spy type widening required for process.stdout/stderr
let stdoutSpy: any;
// biome-ignore lint/suspicious/noExplicitAny: spy type widening required for process.stdout/stderr
let stderrSpy: any;
let stdoutChunks: string[] = [];

const writeSession = (
  sessionId: string,
  projectId: string,
  entries: unknown[],
): { dir: string; file: string } => {
  const projDir = join(tmp, "projects", projectId);
  mkdirSync(projDir, { recursive: true });
  const file = join(projDir, `${sessionId}.jsonl`);
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n"));
  return { dir: projDir, file };
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cclog-show-"));
  stdoutChunks = [];
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((c: string | Uint8Array) => {
    stdoutChunks.push(typeof c === "string" ? c : Buffer.from(c).toString("utf-8"));
    return true;
  }) as typeof process.stdout.write);
  stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((() => true) as typeof process.stderr.write);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const sessionEntries = (sessionId: string) => [
  {
    type: "user",
    sessionId,
    isSidechain: false,
    message: { role: "user", content: "ask" },
  },
  {
    type: "assistant",
    isSidechain: false,
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "ok" },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
      ],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  },
  {
    type: "user",
    isSidechain: false,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(5000) }],
    },
  },
];

describe("runShow", () => {
  test("default JSON output has no toolCalls field", () => {
    writeSession("aaaa1111", "proj-a", sessionEntries("aaaa1111"));
    runShow("aaaa1111", { claudeDir: tmp, json: true });
    const out = stdoutChunks.join("");
    const parsed = JSON.parse(out);
    expect(parsed.turns[0]).not.toHaveProperty("toolCalls");
  });

  test("--with-tool-output JSON includes toolCalls with truncated output", () => {
    writeSession("aaaa1111", "proj-a", sessionEntries("aaaa1111"));
    runShow("aaaa1111", {
      claudeDir: tmp,
      json: true,
      withToolOutput: true,
      toolOutputLimit: "100",
    });
    const out = stdoutChunks.join("");
    const parsed = JSON.parse(out);
    expect(parsed.turns[0].toolCalls).toHaveLength(1);
    expect(parsed.turns[0].toolCalls[0].name).toBe("Bash");
    expect(parsed.turns[0].toolCalls[0].output).toBe(`${"x".repeat(100)}...`);
  });

  test("--tool-output-limit alone (no --with-tool-output) is silently ignored", () => {
    writeSession("aaaa1111", "proj-a", sessionEntries("aaaa1111"));
    runShow("aaaa1111", { claudeDir: tmp, json: true, toolOutputLimit: "100" });
    const out = stdoutChunks.join("");
    const parsed = JSON.parse(out);
    expect(parsed.turns[0]).not.toHaveProperty("toolCalls");
  });

  test("invalid --tool-output-limit values throw", () => {
    writeSession("aaaa1111", "proj-a", sessionEntries("aaaa1111"));
    expect(() =>
      runShow("aaaa1111", { claudeDir: tmp, withToolOutput: true, toolOutputLimit: "-1" }),
    ).toThrow(/non-negative integer/);
    expect(() =>
      runShow("aaaa1111", { claudeDir: tmp, withToolOutput: true, toolOutputLimit: "abc" }),
    ).toThrow(/non-negative integer/);
    expect(() =>
      runShow("aaaa1111", { claudeDir: tmp, withToolOutput: true, toolOutputLimit: "1.5" }),
    ).toThrow(/non-negative integer/);
  });

  test("only the target session has toolCalls populated (other sessions remain unaffected)", () => {
    writeSession("aaaa1111", "proj-a", sessionEntries("aaaa1111"));
    writeSession("bbbb2222", "proj-b", sessionEntries("bbbb2222"));
    runShow("aaaa1111", { claudeDir: tmp, json: true, withToolOutput: true });
    const out = stdoutChunks.join("");
    const parsed = JSON.parse(out);
    expect(parsed.sessionId).toBe("aaaa1111");
    expect(parsed.turns[0].toolCalls).toHaveLength(1);
  });
});
