import pc from "picocolors";
import { parseSince, projectsDirOf, resolveClaudeDir } from "../core/config.ts";
import { loadSummaries } from "../core/loader.ts";
import type { SessionSummary } from "../core/types.ts";

export type SearchScope = "queries" | "conclusions" | "all";

export type SearchOptions = {
  claudeDir?: string;
  in?: string;
  since?: string;
  project?: string;
};

const shortId = (id: string): string => id.slice(0, 8);

const parseScope = (v: string | undefined): SearchScope => {
  if (v === undefined) return "all";
  if (v === "queries" || v === "conclusions" || v === "all") return v;
  throw new Error(`--in must be one of queries|conclusions|all, got "${v}"`);
};

const highlight = (line: string, needle: string): string => {
  const idx = line.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) return line;
  const before = line.slice(0, idx);
  const match = line.slice(idx, idx + needle.length);
  const after = line.slice(idx + needle.length);
  return `${before}${pc.bgYellow(pc.black(match))}${after}`;
};

const snippet = (text: string, needle: string, pad = 40): string => {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(needle.toLowerCase());
  if (idx < 0) return text.replace(/\s+/g, " ").slice(0, pad * 2);
  const start = Math.max(0, idx - pad);
  const end = Math.min(text.length, idx + needle.length + pad);
  const slice = text.slice(start, end).replace(/\s+/g, " ");
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${slice}${suffix}`;
};

type Hit = {
  session: SessionSummary;
  kind: "Q" | "A";
  index: number;
  text: string;
};

const collectHits = (s: SessionSummary, needle: string, scope: SearchScope): Hit[] => {
  const needleLower = needle.toLowerCase();
  const hits: Hit[] = [];
  s.turns.forEach((t, i) => {
    if (
      (scope === "queries" || scope === "all") &&
      t.user.toLowerCase().includes(needleLower)
    ) {
      hits.push({ session: s, kind: "Q", index: i, text: t.user });
    }
    if (
      (scope === "conclusions" || scope === "all") &&
      t.assistant !== null &&
      t.assistant.toLowerCase().includes(needleLower)
    ) {
      hits.push({ session: s, kind: "A", index: i, text: t.assistant });
    }
  });
  return hits;
};

export const runSearch = (keyword: string, opts: SearchOptions): void => {
  if (keyword.length === 0) {
    throw new Error("search keyword must not be empty");
  }
  const scope = parseScope(opts.in);
  const claudeDir = resolveClaudeDir(opts.claudeDir);
  const sinceMs = parseSince(opts.since);
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

  let total = 0;
  let sessionsWithHits = 0;
  for (const s of summaries) {
    const hits = collectHits(s, keyword, scope);
    if (hits.length === 0) continue;
    sessionsWithHits += 1;
    total += hits.length;
    process.stdout.write(
      `${pc.cyan(shortId(s.sessionId))}  ${pc.dim(s.projectId)}  ${pc.dim(s.endedAt ?? "")}\n`,
    );
    for (const h of hits) {
      const tag = h.kind === "Q" ? pc.green(`${h.kind}${h.index + 1}`) : pc.magenta(`${h.kind}${h.index + 1}`);
      process.stdout.write(`  ${tag}  ${highlight(snippet(h.text, keyword), keyword)}\n`);
    }
  }
  if (total === 0) {
    process.stdout.write(pc.dim(`No matches for "${keyword}".\n`));
  } else {
    process.stdout.write(
      pc.dim(`\n${total} match${total === 1 ? "" : "es"} in ${sessionsWithHits} session(s).\n`),
    );
  }
};
