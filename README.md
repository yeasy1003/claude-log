# claude-log

A small CLI to quickly surface key info from Claude Code conversation history.

Reads Claude Code session logs directly from `~/.claude/projects/*.jsonl` (or `$CLAUDE_CONFIG_DIR`) and gives you three commands: `list`, `show`, `search`. No web UI, no daemon — just stdout.

## Install

```bash
# local
pnpm install
pnpm build
node dist/cli.js --help

# once published
npm i -g @yeasy1003/claude-log
cc-log --help
```

## Usage

```bash
# List recent sessions (default 20 rows)
cc-log list
cc-log list --since 7d --limit 50
cc-log list --project -Users-you-repo-foo
cc-log list --json

# Show a session by id or short prefix (like git short sha)
cc-log show e2a7d418
cc-log show e2a7d418-8305-406a-b072-d38304964866 --json

# Search across queries and assistant conclusions
cc-log search "superpower"
cc-log search "migration" --in conclusions --since 30d
```

## Configuration

The Claude data directory is resolved in this order:

1. `--claude-dir <path>` (CLI flag, per-command)
2. `$CLAUDE_CONFIG_DIR` environment variable
3. `~/.claude` (default)

## What counts as "key info"

For each session, claude-log extracts:

- **User queries** — your actual messages, stripping `<system-reminder>` / `<command-*>` tags and synthetic interrupt markers
- **Assistant conclusions** — the final text each turn (tool calls and reasoning are counted separately)
- **Skills invoked** — `Skill` tool calls with their names/args
- **Tool usage counts** — how many times each tool was used
- **Token totals** — input / output / cache-read / cache-create
- **Timing** — start, end, duration, message count

Sidechain (subagent) entries are excluded by design.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## License

MIT
