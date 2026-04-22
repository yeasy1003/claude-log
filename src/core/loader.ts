import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { extractSession } from "./extractSession.ts";
import type { SessionSummary } from "./types.ts";

export type LoadOptions = {
  projectsDir: string;
  projectFilter?: string | null;
  sinceMs?: number | null;
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

export const loadSummaries = (opts: LoadOptions): SessionSummary[] => {
  const projectFilter = opts.projectFilter ?? null;
  const sinceMs = opts.sinceMs ?? null;
  const files = findJsonlFiles(opts.projectsDir, projectFilter).filter((f) =>
    sinceMs === null ? true : f.mtimeMs >= sinceMs,
  );
  const summaries: SessionSummary[] = [];
  for (const f of files) {
    let contents: string;
    try {
      contents = readFileSync(f.file, "utf-8");
    } catch {
      continue;
    }
    const entries = parseJsonlLines(contents);
    const s = extractSession({
      entries,
      projectId: f.projectId,
      sourceFile: f.file,
      sourceMtimeMs: f.mtimeMs,
    });
    if (s.sessionId === "") s.sessionId = f.sessionId;
    summaries.push(s);
  }
  return summaries;
};
