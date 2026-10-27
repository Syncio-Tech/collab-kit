// The signals branch: heartbeat / ack / remind. Informational only - ticket state lives in conversation/ on main.
import { execFileSync } from "node:child_process";
import { Config, githubOf } from "./config.js";
import { git, isRepo } from "./git.js";
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

export function fetchSignals(root: string): void {
  if (!hasRemote(root)) return;
  try { execFileSync("git", ["fetch", "--quiet", "origin", `+${LOCAL_REF}:${REMOTE_REF}`], { cwd: root, stdio: "ignore", timeout: 15000 }); } catch { /* no branch yet / offline */ }
}

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
  for (let attempt = 0; attempt < 4; attempt++) {
    fetchSignals(root);
    const parent = signalsRef(root);
    const cur = parent ? readSignals(root, parent) : {};
    const idx = `${root}/.git/collab-signals-index-${process.pid}`;
    const env = { GIT_INDEX_FILE: idx };
    try {
      if (parent) run(root, ["read-tree", parent], { env }); else run(root, ["read-tree", "--empty"], { env });
      let changed = false;
      for (const [path, fn] of Object.entries(updates)) {
        const before = cur[path];
        const next = fn(before === undefined ? undefined : JSON.parse(JSON.stringify(before)));
        if (next === undefined && before === undefined) continue;
        if (JSON.stringify(next) === JSON.stringify(before)) continue;
        changed = true;
        if (next === null || next === undefined) { run(root, ["update-index", "--force-remove", path], { env }); continue; }
        const blob = run(root, ["hash-object", "-w", "--stdin"], { input: JSON.stringify(next, null, 2) + "\n" });
        run(root, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { env });
      }
      if (!changed) return false;
      // GitHub runs only workflows present in the pushed commit: carry main's signals workflow on this branch
      const wfPath = ".github/workflows/collabkit-signals.yml";
      for (const base of ["refs/remotes/origin/main", "HEAD"]) {
        const blob = git(root, ["rev-parse", "--verify", "--quiet", `${base}:${wfPath}`], true);
        if (blob) { run(root, ["update-index", "--add", "--cacheinfo", `100644,${blob},${wfPath}`], { env }); break; }
      }
      const tree = run(root, ["write-tree"], { env });
      const commit = run(root, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message]);
      if (!hasRemote(root)) { run(root, ["update-ref", LOCAL_REF, commit]); return true; }
      try { run(root, ["push", "--quiet", "origin", `${commit}:${LOCAL_REF}`]); run(root, ["update-ref", REMOTE_REF, commit]); return true; }
      catch { /* someone pushed first: retry on the new tip */ }
    } finally { try { execFileSync("rm", ["-f", idx]); } catch { /* ignore */ } }
  }
  throw new Error("could not update the signals branch after 4 attempts");
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
