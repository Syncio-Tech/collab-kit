// Activity log: what each party did with collab (commands, exit codes, errors, notes), to find friction.
// Local first (~/.collabkit/activity/<project>.pending.jsonl), then pushed to the spec repo's side branch
// `collab/activity` (never merged; one file per party). No ticket content, no free-text arguments.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Config } from "./config.js";
import { readBranchFiles, fetchBranch, writeBranch } from "./signals.js";
import { CollabEvent } from "./events.js";
import { VERSION } from "./util.js";

export const ACTIVITY_BRANCH = "collab/activity";
const home = () => process.env.COLLAB_HOME ?? join(homedir(), ".collabkit");
export const pendingPath = (project: string) => join(home(), "activity", `${project.replace(/[^a-zA-Z0-9._-]/g, "-")}.pending.jsonl`);

/** Who is at the keyboard: an agent when run from an agent's shell (Claude Code sets CLAUDECODE=1) or by the runner. */
export function actorKind(): "agent" | "human" {
  const e = process.env;
  return e.CLAUDECODE === "1" || e.COLLAB_AUTO === "1" || e.COLLAB_AGENT === "1" ? "agent" : "human";
}

const SAFE_VALUES = new Set(["level", "decision", "points", "type", "ticket"]);
/** Command line without free text: ticket ids, subcommands and flag names (values only for a few enum flags). */
export function sanitizeArgs(cmd: string, pos: string[], flags: Record<string, string | boolean>): string[] {
  const out: string[] = [];
  for (const p of pos) {
    const id = /^([A-Za-z]+-)?\d{1,6}(=.*)?$/.exec(p);
    if (id) out.push(p.split("=")[0] + (p.includes("=") ? "=…" : ""));
    else if (["auto", "activity"].includes(cmd) && /^[a-z]+$/.test(p)) out.push(p);
  }
  for (const [k, v] of Object.entries(flags)) {
    if (["cwd"].includes(k)) continue;
    out.push(typeof v === "string" && SAFE_VALUES.has(k) && v.length < 40 ? `--${k}=${v}` : `--${k}`);
  }
  return out;
}

export interface ActivityInput {
  type: "command" | "note"; command?: string; args?: string[]; exit?: number; ms?: number; error?: string; text?: string;
  by?: string; role?: string;
}

export function record(cfg: Config, a: ActivityInput): CollabEvent {
  const time = new Date().toISOString();
  const data: Record<string, any> = { actor: a.by ?? "unknown", role: a.role ?? "unknown", kind: actorKind(), collabkit: VERSION };
  if (a.type === "command") Object.assign(data, { command: a.command, args: a.args ?? [], exit: a.exit ?? 0, ms: a.ms ?? 0, ...(a.error ? { error: a.error.split("\n")[0].split(homedir()).join("~").slice(0, 300) } : {}) });
  else data.text = (a.text ?? "").slice(0, 2000);
  const ev: CollabEvent = { specversion: "1.0", id: createHash("sha1").update(`${time}\0${process.pid}\0${Math.random()}`).digest("hex").slice(0, 16),
    source: `collabkit:${cfg.project}`, type: `tech.collabkit.activity.${a.type}`, time, datacontenttype: "application/json", data: data as any };
  const p = pendingPath(cfg.project);
  mkdirSync(join(home(), "activity"), { recursive: true });
  appendFileSync(p, JSON.stringify(ev) + "\n");
  return ev;
}

/** Move pending local events onto the activity branch. Returns how many were pushed. */
export function pushActivity(root: string, cfg: Config): number {
  const p = pendingPath(cfg.project);
  if (!existsSync(p)) return 0;
  const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
  if (!lines.length) return 0;
  const byFile: Record<string, string[]> = {};
  for (const l of lines) { try { const e = JSON.parse(l); const f = `${e.data?.role ?? "unknown"}.jsonl`; (byFile[f] ??= []).push(l); } catch { /* skip bad line */ } }
  const updates: Record<string, (cur: string | undefined) => string> = {};
  for (const [f, ls] of Object.entries(byFile)) updates[f] = (cur) => (cur ? cur + "\n" : "") + ls.join("\n") + "\n";
  writeBranch(root, ACTIVITY_BRANCH, updates, `activity: ${lines.length} event(s)`);
  writeFileSync(p, "");
  return lines.length;
}

/** Everything on the activity branch plus what is still pending on this machine. */
export function readActivity(root: string, cfg: Config): CollabEvent[] {
  fetchBranch(root, ACTIVITY_BRANCH);
  const out: CollabEvent[] = [];
  const files = readBranchFiles(root, ACTIVITY_BRANCH, (f) => f.endsWith(".jsonl"));
  const p = pendingPath(cfg.project);
  const texts = [...Object.values(files), existsSync(p) ? readFileSync(p, "utf8") : ""];
  const seen = new Set<string>();
  for (const t of texts) for (const l of t.split("\n").filter(Boolean)) {
    try { const e = JSON.parse(l); if (!seen.has(e.id)) { seen.add(e.id); out.push(e); } } catch { /* skip */ }
  }
  return out.sort((a, b) => a.time.localeCompare(b.time));
}
