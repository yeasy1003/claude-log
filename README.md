# claude-log

A small CLI to quickly surface key info from Claude Code conversation history.

Reads Claude Code session logs directly from `~/.claude/projects/*.jsonl` (or `$CLAUDE_CONFIG_DIR`) and gives you three commands: `list`, `show`, `search`. No web UI, no daemon — just stdout.

## Install

```bash
# install from npm
npm i -g @yeasy1003/claude-log
cc-log --help
```

Or build from source:

```bash
pnpm install
pnpm build
node dist/cli.js --help
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

# Include intermediate tool calls + their results in the output
cc-log show e2a7d418 --with-tool-output
cc-log show e2a7d418 --with-tool-output --tool-output-limit 500
cc-log show e2a7d418 --with-tool-output --tool-output-limit 0   # no truncation

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
- **Tool calls (opt-in via `--with-tool-output` on `show`)** — for each turn, the `tool_use` calls plus their paired `tool_result` outputs, with per-result truncation (default 2000 chars; `--tool-output-limit 0` disables)
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
