#!/usr/bin/env node
import * as C from "./commands.js";
import { loadCtx } from "./core/context.js";
import { CliError, VERSION } from "./core/util.js";

const HELP = `collab (collabkit ${VERSION}) - spec <-> implementation conversation channel for any agent

Setup
  collab init [--project N] [--integration generic,claude] [--spec-agent agent-a --spec-human human-a --spec-mode agent_push]
                 [--impl-agent agent-b --impl-human human-b --impl-mode human_commit] [--as ID] [--force]
  collab link <spec-repo-path> [--as agent-b] [--integration generic,claude]

Daily
  collab whoami
  collab inbox [--all]
  collab open --title T --level T0..T3 --reason R --requirement R|NO_REQUIREMENT [--spec-ref REF] [--area A]
  collab reply <ID> [--points P1,P2] [--waiting-for ID]
  collab conclude <ID>
  collab sign <ID>
  collab decide <ID> --decision approve|park|reject [--option O] [--note N]      (humans)
  collab state <ID> [discussing|in-spec|conformed] [--level Tn] [--ref TAG] [--reason R]
  collab index
  collab check [--base REF] [--pr] [--json]
  collab submit [<ID>] [--dry-run]

Global: --as <id> (or COLLABKIT_AS, or .collabkit/local.yml / link.yml), --cwd <dir>
`;

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) flags[k] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags[k] = argv[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { cmd: pos.shift(), pos, flags };
}

function main(): number {
  const { cmd, pos, flags } = parseArgs(process.argv.slice(2));
  const cwd = typeof flags.cwd === "string" ? flags.cwd : process.cwd();
  const as = typeof flags.as === "string" ? flags.as : undefined;
  switch (cmd) {
    case undefined: case "help": case "--help": process.stdout.write(HELP); return 0;
    case "version": case "--version": process.stdout.write(VERSION + "\n"); return 0;
    case "init": C.cmdInit(cwd, flags); return 0;
    case "link": C.cmdLink(cwd, pos, flags); return 0;
  }
  const ctx = loadCtx(cwd, as, !["index", "check"].includes(cmd!));
  switch (cmd) {
    case "whoami": C.cmdWhoami(ctx); return 0;
    case "inbox": C.cmdInbox(ctx, flags); return 0;
    case "open": C.cmdOpen(ctx, flags); return 0;
    case "reply": C.cmdReply(ctx, pos, flags); return 0;
    case "conclude": C.cmdConclude(ctx, pos); return 0;
    case "sign": C.cmdSign(ctx, pos); return 0;
    case "decide": C.cmdDecide(ctx, pos, flags); return 0;
    case "state": C.cmdState(ctx, pos, flags); return 0;
    case "index": C.cmdIndex(ctx); return 0;
    case "check": return C.cmdCheck(ctx, flags);
    case "submit": C.cmdSubmit(ctx, pos, flags); return 0;
    default: throw new CliError(`unknown command "${cmd}". Run \`collab help\`.`);
  }
}

// `collab ... | head` closes the pipe early; that is not an error.
process.stdout.on("error", (e: any) => { if (e.code === "EPIPE") process.exit(0); throw e; });

try { process.exitCode = main(); }
catch (e: any) {
  process.stderr.write((e instanceof CliError ? "collabkit: " + e.message : e.stack ?? String(e)) + "\n");
  process.exitCode = e instanceof CliError ? e.exitCode : 2;
}
