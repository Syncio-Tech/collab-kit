import { join } from "node:path";
import { Config, allIds, githubOf, identify } from "./config.js";
import { parse } from "./frontmatter.js";
import { changedSince, hasRef, isRepo, showAt } from "./git.js";
import { renderIndex, indexPath } from "./indexmd.js";
import { CONCLUSION, LEVELS, NO_REQUIREMENT, STATES, State, Ticket, TURN_RE, conclusionHash, levelIdx, listTickets, readSig, rel, stances } from "./ticket.js";
import { exists, readText } from "./util.js";

export interface Diag { severity: "error" | "warn"; code: string; file: string; msg: string; }

export const TRANSITIONS: Record<State, State[]> = {
  "open": ["discussing", "agreed", "parked", "rejected"],
  "discussing": ["agreed", "parked", "rejected"],
  "agreed": ["approved", "parked", "rejected", "discussing", "conformed"],
  "approved": ["in-spec", "conformed", "discussing"],
  "in-spec": ["conformed", "discussing"],
  "conformed": ["discussing"],
  "parked": ["discussing", "rejected"],
  "rejected": [],
};

/** One change may bundle several steps; each step is enforced by the CLI, the end state by the invariants below. */
export function reachable(from: State, to: State): boolean {
  const seen = new Set<State>([from]);
  const q: State[] = [from];
  while (q.length) {
    const s = q.shift()!;
    for (const n of TRANSITIONS[s] ?? []) { if (n === to) return true; if (!seen.has(n)) { seen.add(n); q.push(n); } }
  }
  return false;
}

export const REQUIRED = ["id", "title", "level", "level_reason", "state", "waiting_for", "opened_by", "opened_at", "requirement"];

const SECRET_PATTERNS: [string, RegExp][] = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["credentials in URL", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/i],
  ["password assignment", /\b(password|passwd|pwd|secret|api[_-]?key)\s*[:=]\s*['"]?[^\s'"]{6,}/i],
];

export interface CheckOpts { base?: string; pr?: boolean; actor?: string; }

export function check(root: string, cfg: Config, opts: CheckOpts = {}): Diag[] {
  const out: Diag[] = [];
  const err = (code: string, file: string, msg: string) => out.push({ severity: "error", code, file, msg });
  const warn = (code: string, file: string, msg: string) => out.push({ severity: "warn", code, file, msg });
  const ids = allIds(cfg);
  const tickets = listTickets(root, cfg);
  const repo = isRepo(root);
  const base = opts.base ?? (repo && hasRef(root, "HEAD") ? "HEAD" : undefined);
  if (opts.base && repo && !hasRef(root, opts.base)) err("base-missing", "", `base ref ${opts.base} not found`);
  const forbidden = cfg.forbidden_patterns.map((p) => new RegExp(p));

  for (const t of tickets) {
    const f = rel(root, t.file);
    const d = t.doc.data;
    for (const k of REQUIRED) if (d[k] === undefined || d[k] === "") err("required-field", f, `missing \`${k}\``);
    if (d.id && d.id !== t.id) err("id-mismatch", f, `id \`${d.id}\` does not match folder ${t.id}`);
    if (d.level && levelIdx(d.level) < 0) err("level", f, `level must be one of ${LEVELS.join(", ")}`);
    if (d.state && !STATES.includes(d.state)) err("state", f, `state must be one of ${STATES.join(", ")}`);
    if (d.waiting_for && !ids.includes(d.waiting_for) && d.waiting_for !== "none") err("waiting-for", f, `waiting_for \`${d.waiting_for}\` is not a known id (${ids.join(", ")}) or none`);
    if (d.opened_by && !ids.includes(d.opened_by)) err("opened-by", f, `opened_by \`${d.opened_by}\` is not a known id`);
    if (cfg.areas.length && d.area && !cfg.areas.includes(d.area)) err("area", f, `area must be one of ${cfg.areas.join(", ")}`);
    if (d.requirement === NO_REQUIREMENT && d.state && !["parked", "rejected"].includes(d.state)) err("no-requirement", f, `requirement ${NO_REQUIREMENT} must be parked`);
    if (/\bdiffers?[ -]from[ -]spec\b|\bkhác (gói|spec)\b/i.test(t.doc.body + (d.title ?? "")) && levelIdx(d.level) < 2)
      err("spec-diff-level", f, "a ticket that says the code differs from spec must be T2 or higher");

    // decisions
    const needsDecision = ["approved", "rejected"].includes(d.state) || (d.state === "parked" && d.requirement !== NO_REQUIREMENT);
    if (needsDecision) {
      const dec = d.decision;
      if (!dec?.by) err("decision-missing", f, `state ${d.state} needs a decision {by, decision, at}`);
      else {
        try {
          const who = identify(cfg, dec.by);
          if (who.kind !== "human") err("decision-by-agent", f, "only a human can decide");
          else if (levelIdx(d.level) >= 2 && who.role !== "spec-owner") err("decision-wrong-human", f, `${d.level} must be decided by the spec-owner human (${cfg.parties["spec-owner"].human})`);
        } catch { err("decision-by", f, `decision.by \`${dec.by}\` is not a known id`); }
      }
    }
    if (d.state === "conformed" && !d.conformed_ref) err("conformed-ref", f, "state conformed needs `conformed_ref` (the spec tag the code now matches)");
    if (d.state === "conformed" && levelIdx(d.level) >= 2 && !d.decision) err("conformed-skip", f, "T2/T3 cannot reach conformed without an approval decision");
    if (d.state === "agreed" || ["approved", "in-spec", "conformed"].includes(d.state)) {
      if (!t.conclusion) err("conclusion-missing", f, `state ${d.state} needs ${CONCLUSION}`);
      else {
        const sigs = t.conclusion.data.signatures ?? {};
        for (const r of ["spec-owner", "implementer"] as const) if (!sigs[cfg.parties[r].agent]) err("conclusion-unsigned", rel(root, t.conclusionFile), `missing signature of ${cfg.parties[r].agent}`);
      }
    }

    // signatures are bound to the conclusion text
    if (t.conclusion) {
      const cf = rel(root, t.conclusionFile);
      const h = conclusionHash(t.conclusion.body);
      for (const [who, v] of Object.entries(t.conclusion.data.signatures ?? {})) {
        const s = readSig(v);
        if (!s) continue;
        if (s.legacy) { if (["discussing", "agreed"].includes(d.state)) warn("signature-legacy", cf, `${who} signed before collabkit 0.2 (no content hash); re-sign to bind the signature to the text`); }
        else if (s.sha256 !== h) err("signature-stale", cf, `the conclusion changed after ${who} signed; ${who} must read it again and \`collab sign ${t.id}\``);
      }
    }

    // a spec change is always decided by the spec owner's human, whatever the level
    if ((d.state === "in-spec" || d.spec_change_ref) && d.decision?.by && d.decision.by !== cfg.parties["spec-owner"].human)
      err("spec-change-decider", f, `the spec changes only on a decision by ${cfg.parties["spec-owner"].human} (decided by ${d.decision.by})`);

    // caps: stop endless back-and-forth and point-splitting
    const points = new Set(t.turns.flatMap((x) => x.doc.data.points ?? []));
    if (t.turns.length > cfg.max_turns_per_ticket) err("turn-cap", f, `${t.turns.length} turns (max ${cfg.max_turns_per_ticket}): conclude, or escalate and let the human decide`);
    if (points.size > cfg.max_points_per_ticket) err("point-cap", f, `${points.size} points (max ${cfg.max_points_per_ticket}): split into another ticket instead of adding points`);
    const last = t.turns.at(-1);
    if (last && d.state === "discussing" && !t.conclusion) {
      const st = Object.values(stances(last.doc.body));
      if (st.length && st.every((x) => x === "agree")) warn("should-conclude", rel(root, last.file), "every point is agreed: run `collab conclude`, do not reply again");
    }

    // turns
    let expect = 1;
    const perPoint: Record<string, Record<string, number>> = {};
    for (const turn of t.turns) {
      const tf = rel(root, turn.file);
      if (turn.n !== expect) err("turn-order", tf, `expected turn ${String(expect).padStart(2, "0")}`);
      expect = turn.n + 1;
      if (turn.doc.data.by !== turn.by) err("turn-by", tf, `frontmatter by \`${turn.doc.data.by}\` must match file name \`${turn.by}\``);
      if (!ids.includes(turn.by)) err("turn-by", tf, `\`${turn.by}\` is not a known id`);
      for (const p of turn.doc.data.points ?? []) {
        perPoint[p] ??= {};
        perPoint[p][turn.by] = (perPoint[p][turn.by] ?? 0) + 1;
        if (perPoint[p][turn.by] > cfg.max_turns_per_point) err("turns-per-point", tf, `${turn.by} already used ${cfg.max_turns_per_point} turns on point ${p}; escalate to T2 and record the options in the conclusion`);
      }
    }
    for (const [p, by] of Object.entries(perPoint)) {
      const agents = [cfg.parties["spec-owner"].agent, cfg.parties["implementer"].agent];
      const exhausted = agents.every((a) => (by[a] ?? 0) >= cfg.max_turns_per_point);
      if (exhausted && d.state === "discussing" && levelIdx(d.level) < 2) err("escalate", f, `point ${p} used ${cfg.max_turns_per_point} turns on each side without agreement: raise level to T2`);
    }

    // unfilled templates: a turn or ticket that still carries the template text says nothing
    const meaningful = (body: string) => body.split("\n").map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && !l.startsWith("<!--")).length;
    for (const turn of t.turns) {
      const tf = rel(root, turn.file);
      const b = turn.doc.body;
      if (/<name>|^- agree \| disagree \| need data$|^- reason \+ evidence$/m.test(b) || meaningful(b) === 0)
        err("turn-unfilled", tf, "turn still contains the template; write the reply for each point before submitting");
    }
    for (const sec of ["Problem", "Evidence"]) {
      const m = new RegExp(`^## ${sec}[^\\n]*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "m").exec(t.doc.body);
      if (m && meaningful(m[1]) === 0) err("ticket-unfilled", f, `section "${sec}" is empty`);
    }

    // content scans
    const files = [t.file, ...t.turns.map((x) => x.file), ...(t.conclusion ? [t.conclusionFile] : [])];
    for (const file of files) {
      const text = readText(file);
      for (const re of forbidden) if (re.test(text)) err("forbidden-pattern", rel(root, file), `matches forbidden pattern /${re.source}/`);
      for (const [name, re] of SECRET_PATTERNS) if (re.test(text)) err("secret", rel(root, file), `looks like a ${name}; never write secrets into the conversation`);
    }

    // identity: who pushed this change must be allowed to speak for the ids it records
    const vouch = (who: string, file: string, what: string) => {
      if (!opts.actor) return;
      const gh = githubOf(cfg, who);
      if (!gh) { warn("identity-unverified", file, `${what} by ${who}: no github login configured for its party, cannot verify`); return; }
      if (gh.toLowerCase() !== opts.actor.toLowerCase()) err("identity-mismatch", file, `${what} by ${who} was pushed by @${opts.actor}; only @${gh} may push for ${who}`);
    };
    if (base && opts.actor) {
      const prevText0 = showAt(root, base, f);
      const prev0 = prevText0 ? parse(prevText0).data : undefined;
      if (!prev0) vouch(d.opened_by, f, "ticket opened");
      if (d.decision?.by && JSON.stringify(d.decision) !== JSON.stringify(prev0?.decision)) vouch(d.decision.by, f, "decision");
      for (const turn of t.turns) if (showAt(root, base, rel(root, turn.file)) === undefined) vouch(turn.by, rel(root, turn.file), "turn");
      if (t.conclusion) {
        const prevC = showAt(root, base, rel(root, t.conclusionFile));
        const prevSigs = prevC ? parse(prevC).data.signatures ?? {} : {};
        for (const [who, v] of Object.entries(t.conclusion.data.signatures ?? {}))
          if (JSON.stringify(v) !== JSON.stringify(prevSigs[who])) vouch(who, rel(root, t.conclusionFile), "signature");
      }
    }

    // history-based rules
    if (base) {
      const prevText = showAt(root, base, f);
      if (prevText) {
        const prev = parse(prevText).data;
        if (levelIdx(d.level) < levelIdx(prev.level)) {
          const by = d.level_override_by;
          let ok = false;
          if (by) { try { ok = identify(cfg, by).kind === "human"; } catch { ok = false; } }
          if (!ok) err("level-lowered", f, `level lowered ${prev.level} -> ${d.level}; only a human may lower it (set level_override_by: <human id>)`);
        }
        if (prev.state && d.state && prev.state !== d.state && !reachable(prev.state as State, d.state as State))
          err("transition", f, `invalid state change ${prev.state} -> ${d.state}`);
        if (d.state === "conformed" && prev.state === "agreed" && levelIdx(d.level) >= 2) err("transition", f, "T2/T3 must be approved before conformed");
        if (parse(prevText).body.trim() !== t.doc.body.trim()) warn("ticket-body-edited", f, "ticket body changed; prefer adding a turn");
      }
      for (const turn of t.turns) {
        const tf = rel(root, turn.file);
        const prev = showAt(root, base, tf);
        if (prev !== undefined && prev !== readText(turn.file)) err("turn-edited", tf, "turns are append-only; add a new turn instead of editing this one");
      }
    }
  }

  // index freshness
  const ip = indexPath(root, cfg);
  if (exists(ip) && readText(ip) !== renderIndex(root, cfg)) err("index-stale", rel(root, ip), "INDEX.md is out of date: run `collab index`");

  // PR scope
  if (base && repo) {
    const changed = changedSince(root, base);
    const inConv = changed.filter((c) => c.path.startsWith(cfg.folder + "/"));
    const outside = changed.filter((c) => !c.path.startsWith(cfg.folder + "/"));
    // Only ticket changes must stay inside conversation/. Setup and rule changes (init, upgrade, config,
    // README, templates) legitimately touch .github/, agent files, etc. and go through code-owner review.
    const ticketRe = new RegExp(`^${cfg.folder}/${cfg.id_prefix}-\\d{3,}/`);
    const touchesTickets = inConv.some((c) => ticketRe.test(c.path));
    if (opts.pr && touchesTickets && outside.length)
      err("mixed-pr", "", `a ticket change must not touch files outside ${cfg.folder}/: ${outside.map((c) => c.path).join(", ")}`);
    for (const c of inConv) {
      if (c.status === "D") err("deleted", c.path, "conversation files are never deleted");
      if (c.path === `${cfg.folder}/config.yml` || c.path === `${cfg.folder}/README.md`) warn("rules-changed", c.path, "rules/config changed: needs spec-owner approval");
      const m = /\/([^/]+)$/.exec(c.path);
      if (m && c.path.split("/").length === 3 && !TURN_RE.test(m[1]) && m[1] !== "ticket.md" && m[1] !== CONCLUSION && !c.path.includes("/_templates/"))
        warn("unexpected-file", c.path, "unexpected file in a ticket folder");
    }
  }

  // weekly cap
  const weekAgo = Date.now() - 7 * 864e5;
  const counts: Record<string, number> = {};
  for (const t of tickets) {
    const d = t.doc.data;
    if (d.level === "T3" || !d.opened_at) continue;
    if (Date.parse(d.opened_at) >= weekAgo) counts[d.opened_by] = (counts[d.opened_by] ?? 0) + 1;
  }
  for (const [who, n] of Object.entries(counts)) if (n > cfg.max_new_tickets_per_week) err("weekly-cap", "", `${who} opened ${n} non-T3 tickets in 7 days (max ${cfg.max_new_tickets_per_week})`);

  return out;
}

export function formatDiags(ds: Diag[]): string {
  if (!ds.length) return "collab check: OK";
  return ds.map((d) => `${d.severity.toUpperCase().padEnd(5)} ${d.code.padEnd(20)} ${d.file ? d.file + ": " : ""}${d.msg}`).join("\n");
}
