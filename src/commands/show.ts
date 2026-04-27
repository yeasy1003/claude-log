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
