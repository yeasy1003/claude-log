# `show --with-tool-output` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in mode to `cc-log show` that captures and renders intermediate `tool_use` + `tool_result` pairs from each turn, with input/output summaries, dynamic fence escaping, and per-result truncation.

**Architecture:** Extend the existing pure-function pipeline (`extractSession` → `loader` → `renderMarkdown`). Capture is gated by an option threaded through `LoadOptions` / `ExtractInput`. `show` uses a two-phase load (lightweight `loadSummaries` to resolve session, then a single-file re-extract with capture enabled) so memory stays bounded to one session.

**Tech Stack:** TypeScript (strict), Node ≥20, Vitest, Commander, Biome (double quotes, semicolons, lineWidth 100).

**Spec:** `docs/superpowers/specs/2026-04-27-show-tool-output-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/core/types.ts` | modify | Add `ToolCall` type; add optional `toolCalls?: ToolCall[]` to `Turn` |
| `src/core/extractSession.ts` | modify | Accept `ExtractOptions`; capture tool_use + tool_result; text-ify + truncate; pair by `id` |
| `src/core/loader.ts` | modify | Thread `extractOptions` through `LoadOptions`; expose `loadOneSession(file, projectId, mtimeMs, options)` for two-phase use |
| `src/core/renderMarkdown.ts` | modify | Add `summarizeToolInput`; render `### Tool Calls (Qn)` (interleaved) and `## Tool Calls` (sectioned); dynamic backtick fence |
| `src/commands/show.ts` | modify | Parse + validate new flags; two-phase load (light list + single re-extract); pass options to renderer |
| `src/cli.ts` | modify | Register `--with-tool-output` and `--tool-output-limit <n>` on the `show` command |
| `tests/extractSession.toolCalls.test.ts` | create | Unit tests for capture/pair/truncate/text-ify edge cases |
| `tests/renderMarkdown.toolCalls.test.ts` | create | Unit tests for interleaved + sectioned + dynamic fence + input summary |
| `tests/show.test.ts` | create | Integration tests: flag parsing, validation, two-phase load (spied) |
| `README.md` | modify | Document the new flags under Usage; update "What counts as key info" |

---

## Conventions

- Code style: Biome rules in repo (`biome.json`). Double quotes, semicolons, trailing commas, lineWidth 100.
- Imports use `.ts` extension (matches existing code).
- Tests use `describe` / `test` / `expect` from `vitest`.
- Run commands from repo root: `/Users/bytedance/go/github.com/yeasy1003/claude-log`.
- After each task: `pnpm typecheck && pnpm test`. Commit only if both pass.

---

## Task 1: Add `ToolCall` type and optional `toolCalls` on `Turn`

**Files:**
- Modify: `src/core/types.ts`

- [ ] **Step 1: Add the new type**

Replace the contents of `src/core/types.ts` with:

```ts
export type SkillInvocation = {
  name: string;
  args: string | null;
};

export type AgentInvocation = {
  subagent_type: string;
  description: string | null;
};

export type ToolCall = {
  id: string;
  name: string;
  input: unknown;
  output: string | null;
  isError: boolean;
};

export type Turn = {
  user: string;
  assistant: string | null;
  toolCalls?: ToolCall[];
};

export type SessionSummary = {
  sessionId: string;
  projectId: string;
  cwd: string | null;
  gitBranch: string | null;
  startedAt: string | null;
  endedAt: string | null;
  messageCount: number;
  turns: Turn[];
  skillsUsed: SkillInvocation[];
  agentsUsed: AgentInvocation[];
  toolCounts: Record<string, number>;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  sourceFile: string;
  sourceMtimeMs: number;
};
```

- [ ] **Step 2: Verify typecheck passes**

Run: `pnpm typecheck`
Expected: PASS — `toolCalls` is optional, no existing call sites need updating.

- [ ] **Step 3: Verify existing tests still pass**

Run: `pnpm test`
Expected: PASS (all existing tests).

- [ ] **Step 4: Commit**

```bash
git add src/core/types.ts
git commit -m "feat(types): add ToolCall type and optional Turn.toolCalls

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Capture `tool_use` + `tool_result` pairs in `extractSession`

**Files:**
- Modify: `src/core/extractSession.ts`
- Test: `tests/extractSession.toolCalls.test.ts` (create)

- [ ] **Step 1: Write the failing test file**

Create `tests/extractSession.toolCalls.test.ts`:

```ts
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
    expect("toolCalls" in result.turns[0]!).toBe(false);
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
    expect(result.turns[0]!.toolCalls).toEqual([
      {
        id: "t1",
        name: "Bash",
        input: { command: "ls" },
        output: "file1\nfile2",
        isError: false,
      },
    ]);
    expect(result.turns[1]!.toolCalls).toEqual([]);
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
    expect(result.turns[0]!.toolCalls?.[0]?.output).toBe("contents");
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
    const calls = result.turns[0]!.toolCalls!;
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
    expect(result.turns[0]!.toolCalls).toEqual([]);
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
    expect(result.turns[0]!.toolCalls?.[0]?.output).toBeNull();
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
    expect(result.turns[0]!.toolCalls?.[0]?.output).toBe("line 1\n[image omitted]\nline 3");
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
    expect(result.turns[0]!.toolCalls?.[0]?.isError).toBe(false);
    expect(result.turns[0]!.toolCalls?.[1]?.isError).toBe(true);
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
    expect(result.turns[0]!.toolCalls?.[0]?.output).toBe(`${"x".repeat(100)}...`);
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
    expect(result.turns[0]!.toolCalls?.[0]?.output).toBe(longOutput);
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
    const ids = result.turns[0]!.toolCalls!.map((c) => c.id);
    expect(ids).toEqual(["main"]);
  });
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `pnpm test tests/extractSession.toolCalls.test.ts`
Expected: FAIL — `extractSession` doesn't accept `options`, doesn't produce `toolCalls`.

- [ ] **Step 3: Modify `src/core/extractSession.ts` to support capture**

Apply the following changes to `src/core/extractSession.ts`:

a. After the `import` line at the top, add `ToolCall` to the imports:

```ts
import type {
  AgentInvocation,
  SessionSummary,
  SkillInvocation,
  ToolCall,
  Turn,
} from "./types.ts";
```

b. Add helper functions just below `isSyntheticUserText` (before `export type ExtractInput`):

```ts
const toolResultToText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
    } else if (isObj(item) && item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    } else if (isObj(item) && item.type === "image") {
      parts.push("[image omitted]");
    }
  }
  return parts.join("\n");
};

const truncate = (s: string, limit: number): string => {
  if (limit === 0) return s;
  if (s.length <= limit) return s;
  return `${s.slice(0, limit)}...`;
};
```

c. Replace the `ExtractInput` type and the `extractSession` function. Find:

```ts
export type ExtractInput = {
  entries: unknown[];
  projectId: string;
  sourceFile: string;
  sourceMtimeMs: number;
};

export const extractSession = (input: ExtractInput): SessionSummary => {
  const { entries, projectId, sourceFile, sourceMtimeMs } = input;
```

Replace with:

```ts
export type ExtractOptions = {
  captureToolCalls?: boolean;
  toolOutputLimit?: number;
};

export type ExtractInput = {
  entries: unknown[];
  projectId: string;
  sourceFile: string;
  sourceMtimeMs: number;
  options?: ExtractOptions;
};

export const extractSession = (input: ExtractInput): SessionSummary => {
  const { entries, projectId, sourceFile, sourceMtimeMs, options } = input;
  const captureCalls = options?.captureToolCalls === true;
  const outputLimit = options?.toolOutputLimit ?? 2000;
  const pendingToolUses = new Map<string, { turnIndex: number; callIndex: number }>();
```

d. Replace the entire `if (type === "user") { ... }` block. The new block (i) processes any `tool_result` items first (regardless of whether the entry also contains user text), and (ii) when the entry yields a real user query, creates a turn with `toolCalls: []` if capture is on. Replace with:

```ts
    if (type === "user") {
      if (raw.isMeta === true) continue;
      if (captureCalls) {
        const message = raw.message;
        if (isObj(message) && Array.isArray(message.content)) {
          for (const item of message.content) {
            if (!isObj(item) || item.type !== "tool_result") continue;
            const useId = getStr(item.tool_use_id);
            if (useId === null) continue;
            const ref = pendingToolUses.get(useId);
            if (ref === undefined) continue;
            const turn = turns[ref.turnIndex];
            const call = turn?.toolCalls?.[ref.callIndex];
            if (call === undefined) continue;
            const rawText = toolResultToText(item.content);
            call.output = truncate(rawText, outputLimit);
            call.isError = item.is_error === true;
            pendingToolUses.delete(useId);
          }
        }
      }
      const text = extractUserText(raw);
      if (text === null) continue;
      const cleaned = classifyUserText(text);
      if (cleaned === null) continue;
      if (isSyntheticUserText(cleaned)) continue;
      const newTurn: Turn = { user: cleaned, assistant: null };
      if (captureCalls) newTurn.toolCalls = [];
      turns.push(newTurn);
      messageCount += 1;
      continue;
    }
```

e. Inside the `type === "assistant"` branch, in the `for (const tu of parts.toolUses)` loop, add tool-call capture AFTER the existing `toolCounts` / `Skill` / `Agent` handling. The current loop is:

```ts
      for (const tu of parts.toolUses) {
        toolCounts[tu.name] = (toolCounts[tu.name] ?? 0) + 1;
        if (tu.name === "Skill" && isObj(tu.input)) {
          // ...
        } else if (tu.name === "Agent" && isObj(tu.input)) {
          // ...
        }
      }
```

We need access to `id` per tool_use. Update `extractAssistantParts` to include the id. Find:

```ts
type AssistantParts = {
  text: string | null;
  toolUses: Array<{ name: string; input: unknown }>;
```

Change to:

```ts
type AssistantParts = {
  text: string | null;
  toolUses: Array<{ id: string | null; name: string; input: unknown }>;
```

And in the same function, find:

```ts
    } else if (item.type === "tool_use" && typeof item.name === "string") {
      toolUses.push({ name: item.name, input: item.input });
    }
```

Change to:

```ts
    } else if (item.type === "tool_use" && typeof item.name === "string") {
      const id = typeof item.id === "string" ? item.id : null;
      toolUses.push({ id, name: item.name, input: item.input });
    }
```

Now in the assistant branch loop in `extractSession`, append (after the existing `if (tu.name === "Skill" ...)` chain):

```ts
        if (captureCalls && tu.id !== null) {
          const lastTurn = turns[turns.length - 1];
          if (lastTurn !== undefined && lastTurn.toolCalls !== undefined) {
            const call: ToolCall = {
              id: tu.id,
              name: tu.name,
              input: tu.input,
              output: null,
              isError: false,
            };
            const callIndex = lastTurn.toolCalls.length;
            lastTurn.toolCalls.push(call);
            pendingToolUses.set(tu.id, {
              turnIndex: turns.length - 1,
              callIndex,
            });
          }
        }
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `pnpm test tests/extractSession.toolCalls.test.ts`
Expected: PASS — all 11 cases.

- [ ] **Step 5: Run the full test suite (regression check)**

Run: `pnpm test`
Expected: PASS — existing extractSession tests untouched.

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/extractSession.ts tests/extractSession.toolCalls.test.ts
git commit -m "feat(extract): capture tool_use + tool_result pairs when enabled

Pairing is by tool_use.id (position-independent), output is text-ified
(handles array content + image placeholder), and truncation is
applied at extraction time. Default (option off) leaves Turn.toolCalls
absent — no schema change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Add `extractOptions` to `LoadOptions` and expose `loadOneSession`

**Files:**
- Modify: `src/core/loader.ts`

- [ ] **Step 1: Update `loader.ts`**

Replace the contents of `src/core/loader.ts` with:

```ts
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { type ExtractOptions, extractSession } from "./extractSession.ts";
import type { SessionSummary } from "./types.ts";

export type LoadOptions = {
  projectsDir: string;
  projectFilter?: string | null;
  sinceMs?: number | null;
  extractOptions?: ExtractOptions;
};

type FileRef = {
  projectId: string;
  sessionId: string;
  file: string;
  mtimeMs: number;
};

const findJsonlFiles = (projectsDir: string, projectFilter: string | null): FileRef[] => {
  const out: FileRef[] = [];
  if (!existsSync(projectsDir)) return out;
  for (const projectId of readdirSync(projectsDir)) {
    if (projectFilter !== null && projectId !== projectFilter) continue;
    const projDir = join(projectsDir, projectId);
    let pstat: ReturnType<typeof statSync>;
    try {
      pstat = statSync(projDir);
    } catch {
      continue;
    }
    if (!pstat.isDirectory()) continue;
    for (const entry of readdirSync(projDir)) {
      if (!entry.endsWith(".jsonl")) continue;
      const file = join(projDir, entry);
      let fstat: ReturnType<typeof statSync>;
      try {
        fstat = statSync(file);
      } catch {
        continue;
      }
      if (!fstat.isFile()) continue;
      out.push({
        projectId,
        sessionId: basename(entry, ".jsonl"),
        file,
        mtimeMs: fstat.mtimeMs,
      });
    }
  }
  return out;
};

const parseJsonlLines = (contents: string): unknown[] => {
  const entries: unknown[] = [];
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines — JSONL streams sometimes contain partial writes
    }
  }
  return entries;
};

export type LoadOneSessionInput = {
  file: string;
  projectId: string;
  sessionId: string;
  mtimeMs: number;
  options?: ExtractOptions;
};

export const loadOneSession = (input: LoadOneSessionInput): SessionSummary | null => {
  let contents: string;
  try {
    contents = readFileSync(input.file, "utf-8");
  } catch {
    return null;
  }
  const entries = parseJsonlLines(contents);
  const s = extractSession({
    entries,
    projectId: input.projectId,
    sourceFile: input.file,
    sourceMtimeMs: input.mtimeMs,
    options: input.options,
  });
  if (s.sessionId === "") s.sessionId = input.sessionId;
  return s;
};

export const loadSummaries = (opts: LoadOptions): SessionSummary[] => {
  const projectFilter = opts.projectFilter ?? null;
  const sinceMs = opts.sinceMs ?? null;
  const files = findJsonlFiles(opts.projectsDir, projectFilter).filter((f) =>
    sinceMs === null ? true : f.mtimeMs >= sinceMs,
  );
  const summaries: SessionSummary[] = [];
  for (const f of files) {
    const s = loadOneSession({
      file: f.file,
      projectId: f.projectId,
      sessionId: f.sessionId,
      mtimeMs: f.mtimeMs,
      options: opts.extractOptions,
    });
    if (s !== null) summaries.push(s);
  }
  return summaries;
};
```

- [ ] **Step 2: Run typecheck and tests**

Run: `pnpm typecheck && pnpm test`
Expected: PASS — `loadOneSession` is additive; `loadSummaries` signature unchanged for default callers.

- [ ] **Step 3: Commit**

```bash
git add src/core/loader.ts
git commit -m "feat(loader): support extractOptions and add loadOneSession helper

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Add per-tool input summary helper

**Files:**
- Modify: `src/core/renderMarkdown.ts`
- Test: `tests/renderMarkdown.toolCalls.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/renderMarkdown.toolCalls.test.ts`:

```ts
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
    expect(summarizeToolInput("Skill", { skill: "loop", args: "5m /foo" })).toBe(
      "loop 5m /foo",
    );
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
    const longCmd = "echo " + "a".repeat(500);
    const summary = summarizeToolInput("Bash", { command: longCmd });
    expect(summary.length).toBe(203);
    expect(summary.endsWith("...")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test tests/renderMarkdown.toolCalls.test.ts`
Expected: FAIL — `summarizeToolInput` is not exported.

- [ ] **Step 3: Add `summarizeToolInput` to `renderMarkdown.ts`**

At the top of `src/core/renderMarkdown.ts`, after the existing `import` line, add helper utilities and export `summarizeToolInput`:

```ts
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const getStr = (v: unknown): string | null => (typeof v === "string" ? v : null);

const INPUT_SUMMARY_LIMIT = 200;

const capInputSummary = (s: string): string =>
  s.length <= INPUT_SUMMARY_LIMIT ? s : `${s.slice(0, INPUT_SUMMARY_LIMIT)}...`;

const fallbackJsonSummary = (input: unknown): string => {
  let raw: string;
  try {
    raw = JSON.stringify(input);
  } catch {
    raw = String(input);
  }
  return capInputSummary(raw ?? "");
};

export const summarizeToolInput = (name: string, input: unknown): string => {
  if (!isObj(input)) return fallbackJsonSummary(input);
  const tryFields = (...fields: string[]): string | null => {
    for (const f of fields) {
      const v = getStr(input[f]);
      if (v !== null && v.length > 0) return v;
    }
    return null;
  };
  let summary: string | null = null;
  switch (name) {
    case "Bash":
      summary = tryFields("command");
      break;
    case "Read":
    case "Edit":
    case "Write":
      summary = tryFields("file_path");
      break;
    case "Grep":
    case "Glob":
      summary = tryFields("pattern");
      break;
    case "Skill": {
      const skill = tryFields("skill");
      if (skill !== null) {
        const args = getStr(input.args);
        summary = args !== null && args.length > 0 ? `${skill} ${args}` : skill;
      }
      break;
    }
    case "Agent":
      summary = tryFields("subagent_type", "description");
      break;
    case "WebFetch":
      summary = tryFields("url");
      break;
    case "WebSearch":
      summary = tryFields("query");
      break;
  }
  if (summary === null) return fallbackJsonSummary(input);
  return capInputSummary(summary);
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test tests/renderMarkdown.toolCalls.test.ts`
Expected: PASS — all 11 cases.

- [ ] **Step 5: Run typecheck + full tests**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/renderMarkdown.ts tests/renderMarkdown.toolCalls.test.ts
git commit -m "feat(render): add per-tool input summary helper

Picks a human-readable summary per tool (Bash command, Read file_path,
Skill name+args, etc.); caps at 200 chars with '...' suffix. Falls
back to JSON.stringify for unknown tools and missing fields.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Render Tool Calls in interleaved + sectioned formats with dynamic fence

**Files:**
- Modify: `src/core/renderMarkdown.ts`
- Modify: `tests/renderMarkdown.toolCalls.test.ts`

- [ ] **Step 1: Append render tests to the existing test file**

Append to `tests/renderMarkdown.toolCalls.test.ts`:

```ts
import { renderMarkdown } from "../src/core/renderMarkdown.ts";
import type { SessionSummary } from "../src/core/types.ts";

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
    const md = renderMarkdown(
      baseSession([{ user: "hi", assistant: "ok" }]),
      "interleaved",
    );
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
    const md = renderMarkdown(
      baseSession([{ user: "first", assistant: "ok" }]),
      "sectioned",
    );
    expect(md).not.toContain("## Tool Calls");
  });
});
```

- [ ] **Step 2: Run tests to verify failures**

Run: `pnpm test tests/renderMarkdown.toolCalls.test.ts`
Expected: FAIL on the new render tests (`summarizeToolInput` tests still pass).

- [ ] **Step 3: Add render functions to `renderMarkdown.ts`**

Add these helpers to `src/core/renderMarkdown.ts` (place above `renderInterleaved`):

```ts
const longestBacktickRun = (s: string): number => {
  const matches = s.match(/`+/g);
  if (matches === null) return 0;
  return Math.max(...matches.map((m) => m.length));
};

const fenceFor = (output: string): string => {
  const longest = longestBacktickRun(output);
  return "`".repeat(Math.max(3, longest + 1));
};

const renderToolCall = (call: ToolCall, index: number): string[] => {
  const lines: string[] = [];
  const errorTag = call.isError ? " [error]" : "";
  const summary = summarizeToolInput(call.name, call.input);
  lines.push(`${index + 1}. **${call.name}**${errorTag} — \`${summary}\``);
  if (call.output === null) {
    lines.push("   _(no output captured)_");
  } else {
    const fence = fenceFor(call.output);
    lines.push(fence);
    lines.push(call.output);
    lines.push(fence);
  }
  return lines;
};
```

Add `ToolCall` to the import at the top of the file:

```ts
import type { SessionSummary, ToolCall } from "./types.ts";
```

In `renderInterleaved`, between the `Q${num}` block and the `A${num}` block, insert a Tool Calls block when present. The current loop body:

```ts
  s.turns.forEach((t, i) => {
    const num = i + 1;
    lines.push(`### Q${num}`);
    lines.push("");
    lines.push(`> ${t.user.replace(/\n/g, "\n> ")}`);
    lines.push("");
    lines.push(`### A${num}`);
    ...
```

Becomes:

```ts
  s.turns.forEach((t, i) => {
    const num = i + 1;
    lines.push(`### Q${num}`);
    lines.push("");
    lines.push(`> ${t.user.replace(/\n/g, "\n> ")}`);
    lines.push("");
    if (t.toolCalls !== undefined && t.toolCalls.length > 0) {
      lines.push(`### Tool Calls (Q${num})`);
      lines.push("");
      t.toolCalls.forEach((c, ci) => {
        for (const line of renderToolCall(c, ci)) lines.push(line);
      });
      lines.push("");
    }
    lines.push(`### A${num}`);
    lines.push("");
    if (t.assistant === null) {
      lines.push("_(no assistant text — turn had only tool calls, or was interrupted)_");
    } else {
      lines.push(t.assistant);
    }
    lines.push("");
  });
```

Add a sectioned render block. After `renderSectioned` produces its existing `## User Queries` and `## Assistant Conclusions` sections, add a Tool Calls section before returning. Update `renderSectioned`:

```ts
const renderSectioned = (s: SessionSummary): string[] => {
  const lines: string[] = [];
  lines.push("## User Queries");
  lines.push("");
  if (s.turns.length === 0) {
    lines.push("_(none)_");
  } else {
    s.turns.forEach((t, i) => {
      lines.push(`### Q${i + 1}`);
      lines.push("");
      lines.push(`> ${t.user.replace(/\n/g, "\n> ")}`);
      lines.push("");
    });
  }

  lines.push("## Assistant Conclusions");
  lines.push("");
  const answered = s.turns.filter((t) => t.assistant !== null);
  if (answered.length === 0) {
    lines.push("_(none)_");
  } else {
    let i = 0;
    for (const t of s.turns) {
      if (t.assistant === null) continue;
      i += 1;
      lines.push(`### A${i}`);
      lines.push("");
      lines.push(t.assistant);
      lines.push("");
    }
  }

  const turnsWithCalls = s.turns
    .map((t, i) => ({ turn: t, num: i + 1 }))
    .filter((x) => x.turn.toolCalls !== undefined && x.turn.toolCalls.length > 0);
  if (turnsWithCalls.length > 0) {
    lines.push("## Tool Calls");
    lines.push("");
    for (const { turn, num } of turnsWithCalls) {
      lines.push(`### Q${num}`);
      lines.push("");
      turn.toolCalls!.forEach((c, ci) => {
        for (const line of renderToolCall(c, ci)) lines.push(line);
      });
      lines.push("");
    }
  }
  return lines;
};
```

- [ ] **Step 4: Run all tests + typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: PASS — all render tests + existing test suite green.

- [ ] **Step 5: Commit**

```bash
git add src/core/renderMarkdown.ts tests/renderMarkdown.toolCalls.test.ts
git commit -m "feat(render): render Tool Calls in interleaved and sectioned formats

Per-turn block in interleaved (between Q and A); single section grouped
by Q in sectioned. Output uses dynamic backtick fence sized to escape
any backtick run in the content. Sections are omitted entirely when
the turn has no toolCalls.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Wire CLI flags and two-phase load in `show`

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/commands/show.ts`
- Test: `tests/show.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/show.test.ts`:

```ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { runShow } from "../src/commands/show.ts";

let tmp: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
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
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write);
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test tests/show.test.ts`
Expected: FAIL — `runShow` doesn't accept the new options.

- [ ] **Step 3: Update `src/commands/show.ts`**

Replace the contents of `src/commands/show.ts` with:

```ts
import pc from "picocolors";
import { projectsDirOf, resolveClaudeDir } from "../core/config.ts";
import { loadOneSession, loadSummaries } from "../core/loader.ts";
import { type RenderFormat, renderMarkdown } from "../core/renderMarkdown.ts";
import { resolveSession } from "../core/resolveSession.ts";

export type ShowOptions = {
  claudeDir?: string;
  json?: boolean;
  format?: string;
  withToolOutput?: boolean;
  toolOutputLimit?: string;
};

const parseFormat = (v: string | undefined): RenderFormat => {
  if (v === undefined) return "interleaved";
  if (v === "interleaved" || v === "sectioned") return v;
  throw new Error(`--format must be one of interleaved|sectioned, got "${v}"`);
};

const parseLimit = (v: string | undefined): number => {
  if (v === undefined) return 2000;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error("--tool-output-limit must be a non-negative integer");
  }
  return n;
};

export const runShow = (query: string, opts: ShowOptions): void => {
  const claudeDir = resolveClaudeDir(opts.claudeDir);
  const format = parseFormat(opts.format);
  const captureToolCalls = opts.withToolOutput === true;
  const toolOutputLimit = captureToolCalls ? parseLimit(opts.toolOutputLimit) : 2000;
  const summaries = loadSummaries({ projectsDir: projectsDirOf(claudeDir) });
  const result = resolveSession(summaries, query);

  if (result.kind === "none") {
    process.stderr.write(pc.red(`No session matches "${query}" in ${claudeDir}\n`));
    process.exit(1);
  }
  if (result.kind === "ambiguous") {
    process.stderr.write(
      pc.yellow(`Ambiguous: "${query}" matches ${result.candidates.length} sessions:\n`),
    );
    for (const c of result.candidates.slice(0, 10)) {
      const firstQuery = (c.turns[0]?.user ?? "").replace(/\s+/g, " ").slice(0, 60);
      process.stderr.write(`  ${pc.cyan(c.sessionId)}  ${pc.dim(c.projectId)}  ${firstQuery}\n`);
    }
    if (result.candidates.length > 10) {
      process.stderr.write(pc.dim(`  … ${result.candidates.length - 10} more\n`));
    }
    process.exit(2);
  }

  const target = result.session;
  const session = captureToolCalls
    ? (loadOneSession({
        file: target.sourceFile,
        projectId: target.projectId,
        sessionId: target.sessionId,
        mtimeMs: target.sourceMtimeMs,
        options: { captureToolCalls: true, toolOutputLimit },
      }) ?? target)
    : target;

  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify(session, null, 2)}\n`);
    return;
  }
  process.stdout.write(renderMarkdown(session, format));
};
```

- [ ] **Step 4: Update `src/cli.ts` to register the flags**

In `src/cli.ts`, find the `show` command registration:

```ts
program
  .command("show <session>")
  .description("Print a markdown summary of a session (prefix match supported)")
  .option(
    "-f, --format <mode>",
    "Layout: interleaved (Q1→A1→Q2→A2, default) or sectioned (all Qs then all As)",
    "interleaved",
  )
  .option("--json", "Emit machine-readable JSON")
  .action((session: string, opts) => {
```

Insert two new options between `--format` and `--json`:

```ts
program
  .command("show <session>")
  .description("Print a markdown summary of a session (prefix match supported)")
  .option(
    "-f, --format <mode>",
    "Layout: interleaved (Q1→A1→Q2→A2, default) or sectioned (all Qs then all As)",
    "interleaved",
  )
  .option(
    "--with-tool-output",
    "Include intermediate tool_use + tool_result pairs for each turn",
  )
  .option(
    "--tool-output-limit <n>",
    "Truncate each tool result to this many characters (0 = no truncation)",
    "2000",
  )
  .option("--json", "Emit machine-readable JSON")
  .action((session: string, opts) => {
```

- [ ] **Step 5: Run all tests + typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: PASS — `tests/show.test.ts` passes, regression tests still green.

- [ ] **Step 6: Build and smoke-test on a real session**

Run: `pnpm build`
Expected: PASS.

Run a quick manual sanity check with a known session id:

```bash
node dist/cli.js list --limit 3
```

Pick one short session id from the output, then:

```bash
node dist/cli.js show <id> --with-tool-output --tool-output-limit 200 | head -80
```

Expected: markdown output containing a `### Tool Calls (Q1)` block (if the session had tool calls). If not, try another session.

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts src/commands/show.ts tests/show.test.ts
git commit -m "feat(show): add --with-tool-output and --tool-output-limit flags

Two-phase load: lightweight loadSummaries to resolve the target,
then a single re-extract of just the target session with capture
enabled. Validates --tool-output-limit as a non-negative integer.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Update README + final verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README**

In `README.md`, replace the existing show example block. Find:

```bash
# Show a session by id or short prefix (like git short sha)
cc-log show e2a7d418
cc-log show e2a7d418-8305-406a-b072-d38304964866 --json
```

Change to:

```bash
# Show a session by id or short prefix (like git short sha)
cc-log show e2a7d418
cc-log show e2a7d418-8305-406a-b072-d38304964866 --json

# Include intermediate tool calls + their results in the output
cc-log show e2a7d418 --with-tool-output
cc-log show e2a7d418 --with-tool-output --tool-output-limit 500
cc-log show e2a7d418 --with-tool-output --tool-output-limit 0   # no truncation
```

In the "What counts as 'key info'" section, add a new bullet between "Skills invoked" and "Tool usage counts":

```markdown
- **Tool calls (opt-in via `--with-tool-output` on `show`)** — for each turn, the `tool_use` calls plus their paired `tool_result` outputs, with per-result truncation (default 2000 chars; `--tool-output-limit 0` disables)
```

- [ ] **Step 2: Final full verification**

Run all three checks:

```bash
pnpm typecheck && pnpm test && pnpm build
```

Expected: ALL PASS.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): document --with-tool-output usage

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Notes for the implementer

- Run `pnpm fix` (Biome) once at the very end if any of the new code triggers lint warnings; don't over-format mid-task.
- Don't introduce new dependencies; everything needed is already in `package.json`.
- If `pnpm test` is flaky on file-system races, `tests/show.test.ts` uses `mkdtempSync` per test — that's the right pattern; don't switch to a shared dir.
- Don't push or open a PR — that's the user's call.
