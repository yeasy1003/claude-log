import type { SessionSummary, ToolCall } from "./types.ts";

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

const fmtTs = (ts: string | null): string => ts ?? "unknown";

const fmtDuration = (start: string | null, end: string | null): string => {
  if (start === null || end === null) return "unknown";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = (min / 60).toFixed(1);
  return `${hr}h`;
};

const sortedToolCounts = (counts: Record<string, number>): Array<[string, number]> =>
  Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

const n = (v: number): string => v.toLocaleString("en-US");

const renderHeader = (s: SessionSummary): string[] => {
  const lines: string[] = [];
  lines.push(`# Session ${s.sessionId || "(unknown)"}`);
  lines.push("");
  lines.push(`- **Project**: \`${s.projectId}\``);
  if (s.cwd !== null) lines.push(`- **CWD**: \`${s.cwd}\``);
  if (s.gitBranch !== null) lines.push(`- **Branch**: \`${s.gitBranch}\``);
  lines.push(`- **Started**: ${fmtTs(s.startedAt)}`);
  lines.push(`- **Ended**: ${fmtTs(s.endedAt)}`);
  lines.push(`- **Duration**: ${fmtDuration(s.startedAt, s.endedAt)}`);
  const answered = s.turns.filter((t) => t.assistant !== null).length;
  lines.push(
    `- **Turns**: ${s.turns.length} (answered: ${answered}) · **Messages**: ${s.messageCount}`,
  );
  lines.push("");
  lines.push("## Token Usage");
  lines.push("");
  const totalBilled = s.totalInputTokens + s.totalOutputTokens;
  lines.push(`- **Input (fresh)**: ${n(s.totalInputTokens)}`);
  lines.push(`- **Output**:        ${n(s.totalOutputTokens)}`);
  lines.push(`- **Cache read**:    ${n(s.totalCacheReadTokens)}`);
  lines.push(`- **Cache created**: ${n(s.totalCacheCreationTokens)}`);
  lines.push(`- **Billed total**:  ${n(totalBilled)}  _(input + output)_`);
  lines.push("");
  return lines;
};

const tallyNames = (names: string[]): Array<[string, number]> => {
  const counts = new Map<string, number>();
  for (const name of names) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};

const fmtTally = (name: string, count: number): string =>
  count > 1 ? `- \`${name}\` ×${count}` : `- \`${name}\``;

const renderFooter = (s: SessionSummary): string[] => {
  const lines: string[] = [];
  lines.push("## Tools Used");
  lines.push("");
  const tools = sortedToolCounts(s.toolCounts);
  if (tools.length === 0) {
    lines.push("_(none)_");
  } else {
    for (const [name, count] of tools) {
      lines.push(`- \`${name}\`: ${count}`);
    }
  }
  lines.push("");

  lines.push("## Skills Invoked");
  lines.push("");
  if (s.skillsUsed.length === 0) {
    lines.push("_(none)_");
  } else {
    for (const [name, count] of tallyNames(s.skillsUsed.map((sk) => sk.name))) {
      lines.push(fmtTally(name, count));
    }
  }
  lines.push("");

  lines.push("## Agents Spawned");
  lines.push("");
  if (s.agentsUsed.length === 0) {
    lines.push("_(none)_");
  } else {
    for (const [name, count] of tallyNames(s.agentsUsed.map((a) => a.subagent_type))) {
      lines.push(fmtTally(name, count));
    }
  }
  lines.push("");
  return lines;
};

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

const renderInterleaved = (s: SessionSummary): string[] => {
  const lines: string[] = [];
  lines.push("## Conversation");
  lines.push("");
  if (s.turns.length === 0) {
    lines.push("_(no user turns captured)_");
    lines.push("");
    return lines;
  }
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
  return lines;
};

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
      turn.toolCalls?.forEach((c, ci) => {
        for (const line of renderToolCall(c, ci)) lines.push(line);
      });
      lines.push("");
    }
  }
  return lines;
};

export type RenderFormat = "interleaved" | "sectioned";

export const renderMarkdown = (s: SessionSummary, format: RenderFormat = "interleaved"): string => {
  const lines = [
    ...renderHeader(s),
    ...(format === "sectioned" ? renderSectioned(s) : renderInterleaved(s)),
    ...renderFooter(s),
  ];
  return `${lines.join("\n")}\n`;
};
