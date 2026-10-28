// The collaboration log: CloudEvents 1.0, one JSON object per line.
// Ticket events are rebuilt from git history (nothing to write by hand, every event points at its commit);
// runner events and reminders come from the collab/signals branch.
import { createHash } from "node:crypto";
import { Config } from "./config.js";
import { parse } from "./frontmatter.js";
import { git, showAt } from "./git.js";
import { CONCLUSION, TURN_RE, stances, LEVELS } from "./ticket.js";
import { readSignals, Reminder } from "./signals.js";

export interface CollabEvent {
  specversion: "1.0";
  id: string;
  source: string;
  type: string;                 // tech.collabkit.<noun>.<verb>
  time: string;
  subject?: string;             // ticket id
  datacontenttype: "application/json";
  data: Record<string, any> & { actor: string };
}

export const EVENT_TYPES = [
  "ticket.opened", "turn.added", "turn.edited", "level.raised", "level.lowered", "ticket.concluded", "conclusion.edited",
  "conclusion.signed", "decision.recorded", "state.changed", "state.reverted", "file.removed",
  "pr.merged", "spec.released", "reminder.sent", "runner.agent_called", "runner.pushed", "runner.discarded", "runner.skipped",
] as const;

const T = (s: string) => `tech.collabkit.${s}`;
const toIso = (s: any, fallback: string): string => {
  if (s instanceof Date) return s.toISOString();
  const t = Date.parse(String(s ?? ""));
  return isFinite(t) ? new Date(t).toISOString() : fallback;
};
const hid = (...p: any[]) => createHash("sha1").update(p.map(String).join("\u0000")).digest("hex").slice(0, 16);
const FORWARD = ["open", "discussing", "agreed", "approved", "in-spec", "conformed"];

interface Commit { sha: string; parent?: string; author: string; date: string; subject: string; body: string; merge: boolean }

function commits(root: string, ref: string): Commit[] {
  const SEP = "\u001e", F = "\u001f";
  const raw = git(root, ["log", "--reverse", "--topo-order", `--format=${SEP}%H${F}%P${F}%an${F}%aI${F}%s${F}%b`, ref], true);
  return raw.split(SEP).filter(Boolean).map((r) => {
    const [sha, parents, author, date, subject, body] = r.split(F);
    const ps = parents.split(" ").filter(Boolean);
    return { sha, parent: ps[0], author, date, subject, body: (body ?? "").trim(), merge: ps.length > 1 };
  });
}

function changed(root: string, c: Commit, folder: string): { status: string; path: string }[] {
  const args = c.parent ? ["diff", "--name-status", "--no-renames", c.parent, c.sha, "--", folder] : ["show", "--name-status", "--no-renames", "--format=", c.sha, "--", folder];
  return git(root, args, true).split("\n").filter(Boolean).map((l) => { const [status, path] = l.split("\t"); return { status: status[0], path }; });
}

const fm = (root: string, ref: string | undefined, path: string) => {
  if (!ref) return undefined;
  const s = showAt(root, ref, path);
  return s === undefined ? undefined : parse(s);
};

/** Who did it: the content says so (turn author, signer, decider); else the ship trailer `Agent: id`; else the git author. */
function trailer(c: Commit): string | undefined { return /^Agent:\s*(\S+)/m.exec(c.body)?.[1]; }

export function buildEvents(root: string, cfg: Config, opts: { ref?: string; signals?: boolean } = {}): CollabEvent[] {
  const ref = opts.ref ?? "HEAD";
  const source = `collabkit:${cfg.project}`;
  const out: CollabEvent[] = [];
  const idRe = new RegExp(`^${cfg.folder}/(${cfg.id_prefix}-\\d{3,})/(.+)$`);
  const push = (type: string, time: string, subject: string | undefined, data: Record<string, any>, key: string) =>
    out.push({ specversion: "1.0", id: hid(type, subject, key), source, type: T(type), time, ...(subject ? { subject } : {}), datacontenttype: "application/json", data: data as any });

  const all = commits(root, ref);
  const ceil = new Map<string, string>();         // event id -> its commit time (an event cannot happen after its commit)
  for (const c of all) {
    const ctime = toIso(c.date, c.date);
    const mark = out.length;
    if (c.merge || /\(#\d+\)$/.test(c.subject)) {
      const m = /Merge pull request #(\d+) from (\S+)/.exec(c.subject) ?? /\(#(\d+)\)$/.exec(c.subject);
      if (m) push("pr.merged", ctime, undefined, { actor: c.author, number: Number(m[1]), branch: m[2] ?? undefined, title: c.subject, commit: c.sha }, c.sha);
      if (c.merge) continue;                       // a merge's content is reported by the commits it brings
    }
    const who = trailer(c) ?? c.author;
    const files = changed(root, c, cfg.folder);
    const byTicket = new Map<string, { status: string; file: string }[]>();
    for (const f of files) { const m = idRe.exec(f.path); if (m) (byTicket.get(m[1]) ?? byTicket.set(m[1], []).get(m[1])!).push({ status: f.status, file: m[2] }); }
    for (const [tid, fs] of byTicket) {
      const p = (f: string) => `${cfg.folder}/${tid}/${f}`;
      const after = fm(root, c.sha, p("ticket.md"));
      const before = fm(root, c.parent, p("ticket.md"));
      const snap = after ? { state: after.data.state, level: after.data.level, waiting_for: after.data.waiting_for } : {};
      const base = (actor: string) => ({ actor, ...snap, commit: c.sha });
      for (const f of fs.sort((a, b) => (a.file === "ticket.md" ? -1 : b.file === "ticket.md" ? 1 : a.file.localeCompare(b.file)))) {
        if (f.status === "D") { push("file.removed", ctime, tid, { ...base(who), file: f.file }, c.sha + f.file); continue; }
        const tm = TURN_RE.exec(f.file);
        if (f.file === "ticket.md") {
          const a = after!.data, b = before?.data;
          // the ticket's own clock only counts when this commit moved it; a revert or a hand edit carries a stale one
          const when = b && a.updated_at !== b.updated_at && Date.parse(String(a.updated_at)) >= Date.parse(String(b.updated_at)) ? toIso(a.updated_at, ctime) : ctime;
          if (!b) { push("ticket.opened", toIso(a.opened_at, ctime), tid, { ...base(a.opened_by ?? who), title: a.title, reason: a.level_reason, requirement: a.requirement, spec_ref: a.spec_ref }, c.sha); continue; }
          if (a.level !== b.level) {
            const up = LEVELS.indexOf(a.level) > LEVELS.indexOf(b.level);
            push(up ? "level.raised" : "level.lowered", when, tid, { ...base(a.level_override_by && !up ? a.level_override_by : who), from: b.level, to: a.level, reason: a.level_reason }, c.sha + "lvl");
          }
          const dec = a.decision, pdec = b.decision;
          if (dec && JSON.stringify(dec) !== JSON.stringify(pdec))
            push("decision.recorded", toIso(dec.at, ctime), tid, { ...base(dec.by ?? who), decision: dec.decision, option: dec.option, note: dec.note }, c.sha + "dec");
          if (a.state !== b.state && !(dec && JSON.stringify(dec) !== JSON.stringify(pdec))) {
            const back = FORWARD.includes(a.state) && FORWARD.includes(b.state) && FORWARD.indexOf(a.state) < FORWARD.indexOf(b.state) && a.state !== "discussing";
            push(back ? "state.reverted" : "state.changed", back ? ctime : when, tid,
              { ...base(who), from: b.state, to: a.state, ...(a.state === "in-spec" ? { ref: a.spec_change_ref } : {}), ...(a.state === "conformed" ? { ref: a.conformed_ref } : {}) }, c.sha + "st");
          }
        } else if (f.file === CONCLUSION) {
          const a = fm(root, c.sha, p(f.file))!, b = fm(root, c.parent, p(f.file));
          if (!b) push("ticket.concluded", ctime, tid, { ...base(who) }, c.sha + "cc");
          else if (a.body.trim() !== b.body.trim()) push("conclusion.edited", ctime, tid, { ...base(who), had_signatures: Object.keys(b.data.signatures ?? {}) }, c.sha + "ce");
          const sa = a.data.signatures ?? {}, sb = b?.data.signatures ?? {};
          for (const k of Object.keys(sa)) if (JSON.stringify(sa[k]) !== JSON.stringify(sb[k]))
            push("conclusion.signed", toIso(sa[k]?.at ?? sa[k], ctime), tid, { ...base(k), sha256: sa[k]?.sha256 }, c.sha + "sig" + k);
        } else if (tm) {
          const d = fm(root, c.sha, p(f.file))!;
          if (f.status === "A") push("turn.added", toIso(d.data.at, ctime), tid, { ...base(tm[2]), turn: Number(tm[1]), points: d.data.points ?? [], stances: stances(d.body) }, c.sha + f.file);
          else push("turn.edited", ctime, tid, { ...base(who), turn: Number(tm[1]), author: tm[2] }, c.sha + f.file);
        }
      }
    }
    for (let i = mark; i < out.length; i++) ceil.set(out[i].id, ctime);
  }
  // keep causal order: within a ticket, time never goes back (a revert restores old timestamps) nor past the commit
  const last = new Map<string, string>();
  for (const e of out) {
    const c = ceil.get(e.id);
    if (c && e.time > c) e.time = c;
    const k = e.subject ?? "";
    if (k && last.has(k) && e.time < last.get(k)!) e.time = c && c > last.get(k)! ? c : last.get(k)!;
    if (k) last.set(k, e.time);
  }

  // spec releases: tags reachable from ref
  const tags = git(root, ["for-each-ref", "refs/tags", "--merged", ref, "--format=%(refname:short)\t%(creatordate:iso-strict)\t%(objectname)"], true);
  for (const l of tags.split("\n").filter(Boolean)) {
    const [tag, date, sha] = l.split("\t");
    push("spec.released", toIso(date, date), undefined, { actor: "spec-owner", tag, commit: sha }, tag);
  }

  if (opts.signals !== false) {
    const sig = readSignals(root);
    for (const [path, v] of Object.entries(sig)) {
      if (path.startsWith("remind/")) for (const r of (v as Reminder).reminded ?? [])
        push("reminder.sent", toIso(r.at, r.at), (v as Reminder).ticket, { actor: r.by, waiting_for: (v as Reminder).waiting_for, waiting_since: (v as Reminder).waiting_since, notify: r.for, level: (v as Reminder).level }, path + r.at);
      if (path.startsWith("events/") && Array.isArray(v)) for (const e of v) if (e?.type && e?.time) out.push(e);
    }
  }
  const seen = new Set<string>();
  return out.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true))).sort((a, b) => a.time.localeCompare(b.time));
}

/** A runner event, in the same envelope (stored on the signals branch, events/<agent>.json, last 500). */
export function runnerEvent(cfg: Config, type: string, actor: string, subject: string | undefined, data: Record<string, any>, time: string): CollabEvent {
  return { specversion: "1.0", id: hid(type, actor, subject, time), source: `collabkit:${cfg.project}`, type: T(type), time,
    ...(subject ? { subject } : {}), datacontenttype: "application/json", data: { actor, ...data } };
}
