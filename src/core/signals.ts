// The signals branch: heartbeat / ack / remind. Informational only - ticket state lives in conversation/ on main.
import { execFileSync } from "node:child_process";
import { Config, githubOf } from "./config.js";
import { fetchQuiet, git, isRepo } from "./git.js";
import { listTickets } from "./ticket.js";

export const SIGNALS_BRANCH = "collab/signals";
const REMOTE_REF = `refs/remotes/origin/${SIGNALS_BRANCH}`;
const LOCAL_REF = `refs/heads/${SIGNALS_BRANCH}`;

export interface Heartbeat { id: string; role: string; at: string; collabkit: string; waiting: { ticket: string; state: string; since: string }[] }
export interface Reminder { ticket: string; level: string; waiting_for: string; waiting_since: string; notify?: string; reminded: { at: string; by: string; for?: string }[] }
export type Signals = Record<string, any>;

function run(cwd: string, args: string[], opts: { input?: string; env?: Record<string, string> } = {}): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", input: opts.input, env: { ...process.env, ...(opts.env ?? {}) }, stdio: ["pipe", "pipe", "pipe"] }).trim();
}
const hasRemote = (root: string) => git(root, ["remote"], true).split("\n").includes("origin");
const refSha = (root: string, ref: string) => git(root, ["rev-parse", "--verify", "--quiet", ref], true) || undefined;

export function fetchSignals(root: string): void { fetchBranch(root, SIGNALS_BRANCH); }

function signalsRef(root: string): string | undefined {
  return hasRemote(root) ? refSha(root, REMOTE_REF) : refSha(root, LOCAL_REF);
}

/** All signal files at a commit (default: the current tip). */
export function readSignals(root: string, at?: string): Signals {
  if (!isRepo(root)) return {};
  const sha = at ?? signalsRef(root);
  if (!sha) return {};
  const out: Signals = {};
  const files = git(root, ["ls-tree", "-r", "--name-only", sha], true).split("\n").filter((p) => p.endsWith(".json"));
  for (const p of files) { try { out[p] = JSON.parse(git(root, ["show", `${sha}:${p}`], true)); } catch { /* skip bad file */ } }
  return out;
}

/**
 * Apply updates to the signals branch. Each update is a function of the current value so concurrent writers
 * (both parties' runners) merge instead of overwriting: fetch, rebuild on the latest tip, push; retry on race.
 * Returns true when something was written.
 */
export function writeSignals(root: string, updates: Record<string, (cur: any) => any>, message: string): boolean {
  const raw: Record<string, (cur: string | undefined) => string | null | undefined> = {};
  for (const [path, fn] of Object.entries(updates)) raw[path] = (cur) => {
    const before = cur === undefined ? undefined : (() => { try { return JSON.parse(cur); } catch { return undefined; } })();
    const next = fn(before === undefined ? undefined : JSON.parse(JSON.stringify(before)));
    if (next === undefined && before === undefined) return undefined;
    if (JSON.stringify(next) === JSON.stringify(before)) return undefined;
    return next === null || next === undefined ? null : JSON.stringify(next, null, 2) + "\n";
  };
  return writeBranch(root, SIGNALS_BRANCH, raw, message, [".github/workflows/collabkit-signals.yml"]);
}

/**
 * Commit file updates straight onto a side branch that is never merged (collab/signals, collab/activity).
 * Each update maps the current text of a file to its new text (undefined = unchanged, null = delete), so concurrent
 * writers merge instead of overwriting: fetch, rebuild on the latest tip, push; retry on race.
 * `carry`: files copied from main into the branch (GitHub runs only workflows present in the pushed commit).
 * Returns true when something was written.
 */
export function writeBranch(root: string, branch: string, updates: Record<string, (cur: string | undefined) => string | null | undefined>,
  message: string, carry: string[] = []): boolean {
  const LREF = `refs/heads/${branch}`, RREF = `refs/remotes/origin/${branch}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    fetchBranch(root, branch);
    const parent = hasRemote(root) ? refSha(root, RREF) : refSha(root, LREF);
    const idx = `${root}/.git/collab-branch-index-${process.pid}`;
    const env = { GIT_INDEX_FILE: idx };
    try {
      if (parent) run(root, ["read-tree", parent], { env }); else run(root, ["read-tree", "--empty"], { env });
      let changed = false;
      for (const [path, fn] of Object.entries(updates)) {
        const cur = parent ? (() => { try { return run(root, ["show", `${parent}:${path}`]) + "\n"; } catch { return undefined; } })() : undefined;
        const next = fn(cur === undefined ? undefined : cur.replace(/\n$/, ""));
        if (next === undefined) continue;
        changed = true;
        if (next === null) { run(root, ["update-index", "--force-remove", path], { env }); continue; }
        const blob = run(root, ["hash-object", "-w", "--stdin"], { input: next });
        run(root, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { env });
      }
      if (!changed) return false;
      for (const wfPath of carry) for (const base of ["refs/remotes/origin/main", "HEAD"]) {
        const blob = git(root, ["rev-parse", "--verify", "--quiet", `${base}:${wfPath}`], true);
        if (blob) { run(root, ["update-index", "--add", "--cacheinfo", `100644,${blob},${wfPath}`], { env }); break; }
      }
      const tree = run(root, ["write-tree"], { env });
      const commit = run(root, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message]);
      if (!hasRemote(root)) { run(root, ["update-ref", LREF, commit]); return true; }
      try { run(root, ["push", "--quiet", "origin", `${commit}:${LREF}`]); run(root, ["update-ref", RREF, commit]); return true; }
      catch { /* someone pushed first: retry on the new tip */ }
    } finally { try { execFileSync("rm", ["-f", idx]); } catch { /* ignore */ } }
  }
  throw new Error(`could not update ${branch} after 4 attempts`);
}

export function fetchBranch(root: string, branch: string): void {
  if (!hasRemote(root)) return;
  fetchQuiet(root, [`+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
}

/** Raw text of every file on a side branch (tip), keyed by path. */
export function readBranchFiles(root: string, branch: string, filter: (p: string) => boolean): Record<string, string> {
  if (!isRepo(root)) return {};
  const sha = hasRemote(root) ? refSha(root, `refs/remotes/origin/${branch}`) : refSha(root, `refs/heads/${branch}`);
  if (!sha) return {};
  const out: Record<string, string> = {};
  for (const p of git(root, ["ls-tree", "-r", "--name-only", sha], true).split("\n").filter(filter))
    try { out[p] = execFileSync("git", ["show", `${sha}:${p}`], { cwd: root, encoding: "utf8" }); } catch { /* skip */ }
  return out;
}

export const DEFAULT_REMIND_HOURS: Record<string, number> = { T0: 72, T1: 72, T2: 24, T3: 2 };

/** Tickets that waited past their level's threshold and have no reminder yet for this wait. */
export function dueReminders(root: string, cfg: Config & { remind_after_hours?: Record<string, number> }, now: number): Reminder[] {
  const hours = { ...DEFAULT_REMIND_HOURS, ...(cfg.remind_after_hours ?? {}) };
  const sig = readSignals(root);
  const out: Reminder[] = [];
  for (const t of listTickets(root, cfg)) {
    const d = t.doc.data;
    if (!d.waiting_for || d.waiting_for === "none" || ["conformed", "rejected", "parked"].includes(d.state)) continue;
    const since = String(d.updated_at ?? d.opened_at ?? "");
    const age = (now - Date.parse(since)) / 36e5;
    if (!(age >= (hours[d.level] ?? 24))) continue;
    const prev: Reminder | undefined = sig[`remind/${t.id}.json`];
    if (prev && prev.waiting_since === since && prev.waiting_for === d.waiting_for && prev.reminded?.length) continue;
    out.push({ ticket: t.id, level: d.level, waiting_for: d.waiting_for, waiting_since: since, notify: githubOf(cfg, d.waiting_for), reminded: [] });
  }
  return out;
}

export function ago(iso: string, now = Date.now()): string {
  const m = Math.round((now - Date.parse(iso)) / 60000);
  if (!isFinite(m)) return "?";
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}
