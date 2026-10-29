#!/usr/bin/env node
import * as C from "./commands.js";
import * as A from "./auto.js";
import * as Hs from "./history.js";
import { pushActivity, record, sanitizeArgs } from "./core/activity.js";
import { loadCtx } from "./core/context.js";
import { CliError, VERSION } from "./core/util.js";

const HELP = `collab (collabkit ${VERSION}) - spec <-> implementation channel for any agent

The loop (one round)
  human:  collab sync                 spec repo back on main, up to date
  agent:  collab                      = collab next: what waits for you, numbered steps
  agent:  (does the steps: open | reply | conclude | sign | state), then collab check
  human:  collab ship [IDs]           branch + commit + push + PR link (agent_push agents may ship themselves)
  human:  merge the PR on GitHub      then back to collab sync

Ticket work (IDs can be short: 4 = SYNC-004)
  collab open --title T --level T0..T3 --reason R --requirement R|NO_REQUIREMENT [--spec-ref REF]
  collab reply 4 [--points P1,P2]       collab conclude 4       collab sign 4
  collab decide 4=A [5=B ...] --decision approve|park|reject|return  (humans; return = send an agreed conclusion back)

Spec-side team (config: parties.spec-owner.members)
  collab assign 4 agent-tue         spec owner gives a ticket to a spec-side agent
  collab escalate 4 --note "..."    specialist: a point only the spec owner can decide
  collab resolve 4 --note "..."     spec owner answers; the ticket goes back (--assign <agent> to hand it over)
  collab state 4 discussing|in-spec|conformed [--level Tn] [--ref TAG]

Look
  collab next | inbox [--all] | whoami | check [--pr --base REF --actor LOGIN] | index

Semi-auto (on your machine; decisions, spec and code stay human)
  collab auto register              in a spec or linked repo: let the runner act for this agent
  collab auto install               every 15 min via launchd (low priority, own clone of the spec repo)
  collab auto now                   run once now and restart the 15-minute cycle
  collab status                     runners last seen, who each ticket waits on, seen/reminded

History (rebuilt from git + the signals branch; CloudEvents 1.0)
  collab log [--pretty] [--ticket 4] [--since DATE] [--type decision.recorded] [--out FILE]
  collab viz [--open] [--out FILE]  one HTML file: timeline, conversations, waiting time, decisions, friction
  collab note "text"                write down a friction point now (needs activity_log: on)
  collab activity [--pretty] [push] what each party ran, failures, notes (branch collab/activity)

Setup and maintenance
  collab init [--project N] [--integration generic,claude] [--spec-github LOGIN --impl-github LOGIN] ...
  collab link <spec-repo-path> [--as agent-b] [--integration generic,claude]
  collab upgrade [--dry-run] [--force]

Global: --as <id> (or COLLAB_AS, .collabkit/local.yml, .collabkit/link.yml), --cwd <dir>, --no-fetch (or COLLAB_NO_FETCH=1)
Install once: npm i -g collabkit-cli   (then every command is just "collab ...")
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
  // read commands must never leave .git/index.lock behind (git status/diff refresh the index opportunistically)
  if (process.env.GIT_OPTIONAL_LOCKS === undefined) process.env.GIT_OPTIONAL_LOCKS = "0";
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.flags["no-fetch"] === true) process.env.COLLAB_NO_FETCH = "1";
  if (parsed.flags.version === true && !parsed.cmd) { process.stdout.write(VERSION + "\n"); return 0; }
  const { cmd, pos, flags } = parsed;
  const t0 = Date.now();
  let code = 0, err: any;
  try { code = run(parsed); return code; }
  catch (e: any) { err = e; code = e instanceof CliError ? e.exitCode : 2; throw e; }
  finally { trackActivity(cmd, pos, flags, code, Date.now() - t0, err); }
}

/** Record the command when the project turned the activity log on; push it on sync / ship / note. Never fails the command. */
function trackActivity(cmd: string | undefined, pos: string[], flags: Record<string, string | boolean>, code: number, ms: number, err: any) {
  const c = cmd ?? "next";
  if (["help", "--help", "-h", "version", "--version", "notify", "activity", "note"].includes(c)) return;
  if (c === "auto" && (pos[0] ?? "run") === "run") return;          // the runner's 1-minute tick
  try {
    const cwd = typeof flags.cwd === "string" ? flags.cwd : process.cwd();
    const ctx = loadCtx(cwd, typeof flags.as === "string" ? flags.as : undefined, false);
    if (!ctx.cfg.activity_log) return;
    record(ctx.cfg, { type: "command", command: c, args: sanitizeArgs(c, pos, flags), exit: code, ms, error: err ? String(err.message ?? err) : undefined,
      by: ctx.me?.id, role: ctx.me?.role });
    if (code === 0 && ["sync", "ship", "submit"].includes(c)) pushActivity(ctx.specRoot, ctx.cfg);
  } catch { /* the activity log is best effort */ }
}

function run({ cmd, pos, flags }: { cmd?: string; pos: string[]; flags: Record<string, string | boolean> }): number {
  const cwd = typeof flags.cwd === "string" ? flags.cwd : process.cwd();
  const as = typeof flags.as === "string" ? flags.as : undefined;
  if (flags.help === true && !cmd) { process.stdout.write(HELP); return 0; }
  switch (cmd) {
    case "help": case "--help": case "-h": process.stdout.write(HELP); return 0;
    case "version": case "--version": process.stdout.write(VERSION + "\n"); return 0;
    case "init": C.cmdInit(cwd, flags); return 0;
    case "link": C.cmdLink(cwd, pos, flags); return 0;
    case "upgrade": C.cmdUpgrade(cwd, flags); return 0;
    case "auto": {
      const sub = pos[0] ?? "run";
      if (sub === "run") { A.cmdAutoRun(flags); return 0; }
      if (sub === "now") { A.cmdAutoRun({ ...flags, now: true }); return 0; }
      if (sub === "install") { A.cmdAutoInstall(flags); return 0; }
      if (sub === "uninstall") { A.cmdAutoUninstall(); return 0; }
      if (sub === "register") { A.cmdAutoRegister(cwd, flags); return 0; }
      throw new CliError("collab auto register | install | now | run | uninstall");
    }
  }
  const ctx = loadCtx(cwd, as, !["index", "check", "sync", "status", "notify", "log", "viz", "activity", "note"].includes(cmd ?? "next"));
  switch (cmd ?? "next") {
    case "whoami": C.cmdWhoami(ctx); return 0;
    case "inbox": C.cmdInbox(ctx, flags); return 0;
    case "next": case "n": C.cmdNext(ctx, flags); return 0;
    case "sync": C.cmdSync(ctx); return 0;
    case "status": A.cmdStatus(ctx); return 0;
    case "log": Hs.cmdLog(ctx, flags); return 0;
    case "viz": Hs.cmdViz(ctx, flags); return 0;
    case "activity": Hs.cmdActivity(ctx, pos, flags); return 0;
    case "note": Hs.cmdNote(ctx, pos); return 0;
    case "notify": return A.cmdNotify(ctx, flags);
    case "ship": C.cmdSubmit(ctx, pos, { ...flags, ship: true }); return 0;
    case "open": C.cmdOpen(ctx, flags); return 0;
    case "reply": C.cmdReply(ctx, pos, flags); return 0;
    case "conclude": C.cmdConclude(ctx, pos); return 0;
    case "sign": C.cmdSign(ctx, pos); return 0;
    case "decide": C.cmdDecide(ctx, pos, flags); return 0;
    case "assign": C.cmdAssign(ctx, pos); return 0;
    case "escalate": C.cmdEscalate(ctx, pos, flags); return 0;
    case "resolve": C.cmdResolve(ctx, pos, flags); return 0;
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
