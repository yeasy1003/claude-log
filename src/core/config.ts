import { homedir } from "node:os";
import { join, resolve } from "node:path";

const expandHome = (p: string): string =>
  p.startsWith("~/") ? join(homedir(), p.slice(2)) : p === "~" ? homedir() : p;

export const resolveClaudeDir = (override?: string): string => {
  if (override !== undefined && override.length > 0) {
    return resolve(expandHome(override));
  }
  const envDir = process.env.CLAUDE_CONFIG_DIR;
  if (envDir !== undefined && envDir.length > 0) {
    return resolve(expandHome(envDir));
  }
  return resolve(homedir(), ".claude");
};

export const projectsDirOf = (claudeDir: string): string => join(claudeDir, "projects");

export const parseSince = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const relMatch = /^(\d+)([dhm])$/.exec(value);
  if (relMatch !== null) {
    const n = Number(relMatch[1]);
    const unit = relMatch[2];
    const ms = unit === "d" ? n * 86400000 : unit === "h" ? n * 3600000 : n * 60000;
    return Date.now() - ms;
  }
  const t = new Date(value).getTime();
  if (Number.isFinite(t)) return t;
  throw new Error(`--since: invalid value "${value}". Use ISO date or relative like 7d/24h/30m.`);
};
