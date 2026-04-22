import pc from "picocolors";
import { parseSince, projectsDirOf, resolveClaudeDir } from "../core/config.ts";
import { loadSummaries } from "../core/loader.ts";
import type { SessionSummary } from "../core/types.ts";

export type ListOptions = {
  claudeDir?: string;
  since?: string;
  project?: string;
  limit?: string;
  json?: boolean;
};

const truncate = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

const shortId = (id: string): string => id.slice(0, 8);

const fmtTime = (ts: string | null): string => {
  if (ts === null) return "unknown";
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return "unknown";
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
};

const firstQueryOneLine = (s: SessionSummary): string => {
  const q = s.turns[0]?.user;
  if (q === undefined) return "";
  return q.replace(/\s+/g, " ").trim();
};

const padEnd = (s: string, width: number): string => {
  const visualLen = [...s].length;
  return visualLen >= width ? s : s + " ".repeat(width - visualLen);
};

export const runList = (opts: ListOptions): void => {
  const claudeDir = resolveClaudeDir(opts.claudeDir);
  const sinceMs = parseSince(opts.since);
  const limit = opts.limit === undefined ? 20 : Number.parseInt(opts.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error(`--limit must be a positive integer, got "${opts.limit}"`);
  }

  const summaries = loadSummaries({
    projectsDir: projectsDirOf(claudeDir),
    projectFilter: opts.project ?? null,
    sinceMs,
  });

  summaries.sort((a, b) => {
    const ta = a.endedAt === null ? 0 : new Date(a.endedAt).getTime();
    const tb = b.endedAt === null ? 0 : new Date(b.endedAt).getTime();
    return tb - ta;
  });
  const shown = summaries.slice(0, limit);

  if (opts.json === true) {
    process.stdout.write(
      `${JSON.stringify(
        shown.map((s) => ({
          id: s.sessionId,
          shortId: shortId(s.sessionId),
          project: s.projectId,
          endedAt: s.endedAt,
          messageCount: s.messageCount,
          firstQuery: firstQueryOneLine(s),
        })),
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (shown.length === 0) {
    process.stdout.write(pc.dim(`No sessions found in ${claudeDir}/projects\n`));
    return;
  }

  const rows = shown.map((s) => {
    const q = firstQueryOneLine(s);
    return {
      id: shortId(s.sessionId),
      time: fmtTime(s.endedAt),
      project: truncate(s.projectId, 32),
      msgs: String(s.messageCount),
      query: q.length === 0 ? "" : truncate(q, 60),
      queryIsEmpty: q.length === 0,
    };
  });
  const header = {
    id: "ID",
    time: "ENDED",
    project: "PROJECT",
    msgs: "MSGS",
    query: "FIRST QUERY",
  };
  const all = [header, ...rows];
  const colw = {
    id: Math.max(...all.map((r) => r.id.length)),
    time: Math.max(...all.map((r) => r.time.length)),
    project: Math.max(...all.map((r) => r.project.length)),
    msgs: Math.max(...all.map((r) => r.msgs.length)),
  };

  const lines: string[] = [];
  lines.push(
    pc.bold(
      [
        padEnd(header.id, colw.id),
        padEnd(header.time, colw.time),
        padEnd(header.project, colw.project),
        padEnd(header.msgs, colw.msgs),
        header.query,
      ].join("  "),
    ),
  );
  for (const r of rows) {
    lines.push(
      [
        pc.cyan(padEnd(r.id, colw.id)),
        pc.dim(padEnd(r.time, colw.time)),
        padEnd(r.project, colw.project),
        pc.yellow(padEnd(r.msgs, colw.msgs)),
        r.queryIsEmpty ? pc.dim("(empty)") : r.query,
      ].join("  "),
    );
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  if (summaries.length > shown.length) {
    process.stdout.write(
      pc.dim(`\n… ${summaries.length - shown.length} more. Use --limit to show more.\n`),
    );
  }
};
