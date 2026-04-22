import type { SessionSummary } from "./types.ts";

export type ResolveResult =
  | { kind: "ok"; session: SessionSummary }
  | { kind: "none"; query: string }
  | { kind: "ambiguous"; query: string; candidates: SessionSummary[] };

export const resolveSession = (
  summaries: SessionSummary[],
  query: string,
): ResolveResult => {
  const exact = summaries.find((s) => s.sessionId === query);
  if (exact !== undefined) return { kind: "ok", session: exact };
  const matches = summaries.filter((s) => s.sessionId.startsWith(query));
  if (matches.length === 0) return { kind: "none", query };
  if (matches.length === 1) {
    const only = matches[0];
    if (only !== undefined) return { kind: "ok", session: only };
  }
  return { kind: "ambiguous", query, candidates: matches };
};
