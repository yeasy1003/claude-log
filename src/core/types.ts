export type SkillInvocation = {
  name: string;
  args: string | null;
};

export type AgentInvocation = {
  subagent_type: string;
  description: string | null;
};

export type Turn = {
  user: string;
  assistant: string | null;
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
