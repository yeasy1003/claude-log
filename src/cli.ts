import { Command } from "commander";
import pc from "picocolors";
import { runList } from "./commands/list.ts";
import { runSearch } from "./commands/search.ts";
import { runShow } from "./commands/show.ts";

const fail = (err: unknown): never => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${pc.red("error:")} ${msg}\n`);
  process.exit(1);
};

const program = new Command();
program
  .name("cc-log")
  .description("Quickly surface key info from Claude Code conversation history")
  .version("0.1.0")
  .option("-C, --claude-dir <path>", "Claude data directory (default: $CLAUDE_CONFIG_DIR or ~/.claude)");

program
  .command("list")
  .description("List recent sessions with key metadata")
  .option("--since <value>", "Only sessions touched within this window (7d, 24h, 30m, or ISO date)")
  .option("--project <id>", "Filter by project id (directory name under projects/)")
  .option("--limit <n>", "Max rows to print", "20")
  .option("--json", "Emit machine-readable JSON")
  .action((opts) => {
    try {
      runList({ ...program.opts(), ...opts });
    } catch (e) {
      fail(e);
    }
  });

program
  .command("show <session>")
  .description("Print a markdown summary of a session (prefix match supported)")
  .option(
    "-f, --format <mode>",
    "Layout: interleaved (Q1→A1→Q2→A2, default) or sectioned (all Qs then all As)",
    "interleaved",
  )
  .option("--json", "Emit machine-readable JSON")
  .action((session: string, opts) => {
    try {
      runShow(session, { ...program.opts(), ...opts });
    } catch (e) {
      fail(e);
    }
  });

program
  .command("search <keyword>")
  .description("Case-insensitive search across user queries and assistant conclusions")
  .option("--in <scope>", "Where to search: queries|conclusions|all", "all")
  .option("--since <value>", "Only sessions touched within this window")
  .option("--project <id>", "Filter by project id")
  .action((keyword: string, opts) => {
    try {
      runSearch(keyword, { ...program.opts(), ...opts });
    } catch (e) {
      fail(e);
    }
  });

program.parseAsync(process.argv).catch(fail);
