import type { AgentInvocation, SessionSummary, SkillInvocation, Turn } from "./types.ts";

type RawEntry = Record<string, unknown>;

const isObj = (v: unknown): v is RawEntry =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const getStr = (v: unknown): string | null => (typeof v === "string" ? v : null);

const stripTags = (text: string): string =>
  text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<command-[a-z-]+>[\s\S]*?<\/command-[a-z-]+>/g, "")
    .replace(/<command-[a-z-]+\s*\/>/g, "")
    .replace(/<local-command-[a-z-]+>[\s\S]*?<\/local-command-[a-z-]+>/g, "")
    .trim();

// Tags whose presence means "this user entry is just framework echo / output, not user intent".
// If the text only contains these (plus whitespace), we discard it entirely.
const ECHO_ONLY_PATTERNS: RegExp[] = [
  /<bash-stdout>[\s\S]*?<\/bash-stdout>/g,
  /<bash-stderr>[\s\S]*?<\/bash-stderr>/g,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
  /<local-command-stderr>[\s\S]*?<\/local-command-stderr>/g,
  /<task-notification>[\s\S]*?<\/task-notification>/g,
];

const isEchoOnly = (text: string): boolean => {
  let stripped = text;
  for (const re of ECHO_ONLY_PATTERNS) stripped = stripped.replace(re, "");
  return stripped.trim().length === 0;
};

// Recognize slash-command invocations like `<command-name>/find-skills</command-name>`.
// Returns the normalized form (e.g. `/find-skills` with optional args) or null.
const extractSlashCommand = (text: string): string | null => {
  const nameMatch = /<command-name>\s*([^<\s][^<]*?)\s*<\/command-name>/.exec(text);
  if (nameMatch === null) return null;
  const name = (nameMatch[1] ?? "").trim();
  if (name.length === 0) return null;
  const argsMatch = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
  const args = (argsMatch?.[1] ?? "").trim();
  return args.length > 0 ? `${name} ${args}` : name;
};

// Recognize bash-input user entries like `<bash-input>git status</bash-input>`.
// Returns `! <command>` (familiar shell-bang convention) or null.
const extractBashInput = (text: string): string | null => {
  const match = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(text);
  if (match === null) return null;
  const cmd = (match[1] ?? "").trim();
  return cmd.length > 0 ? `! ${cmd}` : null;
};

const extractUserText = (entry: RawEntry): string | null => {
  const message = entry.message;
  if (!isObj(message)) return null;
  const content = message.content;
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      texts.push(item);
    } else if (isObj(item) && item.type === "text" && typeof item.text === "string") {
      texts.push(item.text);
    }
  }
  const joined = texts.join("\n").trim();
  return joined.length > 0 ? joined : null;
};

// Classify a raw user text blob into either a meaningful query string or null (skip).
// Order matters: output-echoes are filtered first, then special-form extraction, then
// the generic stripTags fallback.
const classifyUserText = (raw: string): string | null => {
  if (isEchoOnly(raw)) return null;
  const bash = extractBashInput(raw);
  if (bash !== null) return bash;
  const slash = extractSlashCommand(raw);
  if (slash !== null) return slash;
  const cleaned = stripTags(raw);
  return cleaned.length > 0 ? cleaned : null;
};

type AssistantParts = {
  text: string | null;
  toolUses: Array<{ name: string; input: unknown }>;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

const extractAssistantParts = (entry: RawEntry): AssistantParts => {
  const empty: AssistantParts = {
    text: null,
    toolUses: [],
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  const message = entry.message;
  if (!isObj(message)) return empty;
  const content = message.content;
  if (!Array.isArray(content)) return empty;
  const texts: string[] = [];
  const toolUses: Array<{ name: string; input: unknown }> = [];
  for (const item of content) {
    if (!isObj(item)) continue;
    if (item.type === "text" && typeof item.text === "string") {
      texts.push(item.text);
    } else if (item.type === "tool_use" && typeof item.name === "string") {
      toolUses.push({ name: item.name, input: item.input });
    }
  }
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  const usage = message.usage;
  if (isObj(usage)) {
    if (typeof usage.input_tokens === "number") inputTokens = usage.input_tokens;
    if (typeof usage.output_tokens === "number") outputTokens = usage.output_tokens;
    if (typeof usage.cache_read_input_tokens === "number")
      cacheReadTokens = usage.cache_read_input_tokens;
    if (typeof usage.cache_creation_input_tokens === "number")
      cacheCreationTokens = usage.cache_creation_input_tokens;
  }
  const text = texts.join("\n").trim();
  return {
    text: text.length > 0 ? text : null,
    toolUses,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
  };
};

const INTERRUPT_MARKERS = [
  "[Request interrupted by user",
  "[Request interrupted by user for tool use]",
  "Tool use was rejected",
];
const isSyntheticUserText = (text: string): boolean =>
  INTERRUPT_MARKERS.some((m) => text.trim().startsWith(m));

export type ExtractInput = {
  entries: unknown[];
  projectId: string;
  sourceFile: string;
  sourceMtimeMs: number;
};

export const extractSession = (input: ExtractInput): SessionSummary => {
  const { entries, projectId, sourceFile, sourceMtimeMs } = input;

  const turns: Turn[] = [];
  const skillsUsed: SkillInvocation[] = [];
  const agentsUsed: AgentInvocation[] = [];
  const toolCounts: Record<string, number> = {};
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;
  let sessionId = "";
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let messageCount = 0;

  // Pairing invariant: each user query opens a new turn; subsequent assistant text
  // overwrites `assistant` on the last turn (we want the LAST assistant text of the turn).
  // Assistant text produced before any user query is discarded (no turn to attach to).

  for (const raw of entries) {
    if (!isObj(raw)) continue;
    if (raw.isSidechain === true) continue;

    if (!sessionId) {
      const sid = getStr(raw.sessionId);
      if (sid !== null) sessionId = sid;
    }
    cwd ??= getStr(raw.cwd);
    gitBranch ??= getStr(raw.gitBranch);
    const ts = getStr(raw.timestamp);
    if (ts !== null) {
      startedAt ??= ts;
      endedAt = ts;
    }

    const type = raw.type;

    if (type === "user") {
      if (raw.isMeta === true) continue;
      const text = extractUserText(raw);
      if (text === null) continue;
      const cleaned = classifyUserText(text);
      if (cleaned === null) continue;
      if (isSyntheticUserText(cleaned)) continue;
      turns.push({ user: cleaned, assistant: null });
      messageCount += 1;
      continue;
    }

    if (type === "assistant") {
      messageCount += 1;
      const parts = extractAssistantParts(raw);
      if (parts.text !== null) {
        const lastTurn = turns[turns.length - 1];
        if (lastTurn !== undefined) {
          const cleaned = stripTags(parts.text);
          if (cleaned.length > 0) lastTurn.assistant = cleaned;
        }
      }
      totalInputTokens += parts.inputTokens;
      totalOutputTokens += parts.outputTokens;
      totalCacheReadTokens += parts.cacheReadTokens;
      totalCacheCreationTokens += parts.cacheCreationTokens;
      for (const tu of parts.toolUses) {
        toolCounts[tu.name] = (toolCounts[tu.name] ?? 0) + 1;
        if (tu.name === "Skill" && isObj(tu.input)) {
          const skillName = getStr(tu.input.skill);
          if (skillName !== null) {
            skillsUsed.push({ name: skillName, args: getStr(tu.input.args) });
          }
        } else if (tu.name === "Agent" && isObj(tu.input)) {
          // `subagent_type` is optional in the Agent tool — when omitted, Claude Code
          // defaults to the `general-purpose` agent. Record that so users can see at a
          // glance what flavor(s) of agent were spawned.
          const subagentType = getStr(tu.input.subagent_type) ?? "general-purpose";
          agentsUsed.push({
            subagent_type: subagentType,
            description: getStr(tu.input.description),
          });
        }
      }
    }
  }

  return {
    sessionId,
    projectId,
    cwd,
    gitBranch,
    startedAt,
    endedAt,
    messageCount,
    turns,
    skillsUsed,
    agentsUsed,
    toolCounts,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheCreationTokens,
    sourceFile,
    sourceMtimeMs,
  };
};
