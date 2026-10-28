import YAML from "yaml";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { Config, Mode, Role, counterpartAgent, loadConfig, CONFIG_REL } from "./core/config.js";
import { Ctx, loadCtx } from "./core/context.js";
import { parse, stringify } from "./core/frontmatter.js";
import { changedSince, fetchQuiet, git, hasCommand, isRepo } from "./core/git.js";
import { indexPath, renderIndex } from "./core/indexmd.js";
import { INTEGRATIONS, installIntegrations } from "./core/integrations.js";
import { check, formatDiags, TRANSITIONS } from "./core/rules.js";
import { CONCLUSION, LEVELS, NO_REQUIREMENT, STATES, State, Ticket, conclusionHash, convDir, levelIdx, listTickets, loadTicket, nextId, readSig, rel, stances } from "./core/ticket.js";
import { CliError, VERSION, exists, fill, nowIso, readText, sha256, templatePath, writeText } from "./core/util.js";

export type Flags = Record<string, string | boolean>;
const str = (f: Flags, k: string, d?: string): string | undefined => (typeof f[k] === "string" ? (f[k] as string) : d);
const need = (f: Flags, k: string): string => { const v = str(f, k); if (!v) throw new CliError(`--${k} is required`); return v; };
const log = (s = "") => process.stdout.write(s + "\n");
/** A path as the user should type it: relative to where they stand, always quoted. */
const shp = (p: string) => JSON.stringify(relative(process.cwd(), p) || ".");

function ensureGitignore(root: string, lines: string[]) {
  const p = join(root, ".gitignore");
  const cur = exists(p) ? readText(p) : "";
  const missing = lines.filter((l) => !cur.split("\n").includes(l));
  if (missing.length) appendFileSync(p, (cur && !cur.endsWith("\n") ? "\n" : "") + "# collabkit (machine-local)\n" + missing.join("\n") + "\n");
}

function writeIfAbsent(p: string, content: string, force: boolean, written: string[], skipped: string[]) {
  if (exists(p) && !force) { skipped.push(p); return; }
  writeText(p, content); written.push(p);
}

/** "4", "004", "sync-4", "SYNC-004" all mean SYNC-004. */
export function normId(cfg: Config, id: string): string {
  const m = /^(?:([a-z]+)-?)?(\d+)$/i.exec(id.trim());
  return m ? `${(m[1] ?? cfg.id_prefix).toUpperCase()}-${m[2].padStart(3, "0")}` : id.toUpperCase();
}

function getTicket(ctx: Ctx, id: string | undefined): Ticket {
  if (!id) throw new CliError("ticket id required, e.g. 4 or SYNC-004");
  const t = loadTicket(ctx.specRoot, ctx.cfg, normId(ctx.cfg, id));
  if (!t) throw new CliError(`ticket ${id} not found in ${relative(process.cwd(), convDir(ctx.specRoot, ctx.cfg)) || "."}`);
  return t;
}

function save(ctx: Ctx, t: Ticket) {
  t.doc.data.updated_at = nowIso();
  writeText(t.file, stringify(t.doc));
  writeText(indexPath(ctx.specRoot, ctx.cfg), renderIndex(ctx.specRoot, ctx.cfg));
}

function me(ctx: Ctx) { if (!ctx.me) throw new CliError("identity required (--as)"); return ctx.me; }

function decider(cfg: Config, level: string): string {
  return levelIdx(level) >= 2 ? cfg.parties["spec-owner"].human : cfg.parties["implementer"].human;
}

// ---------------------------------------------------------------- init / link
export function cmdInit(cwd: string, f: Flags) {
  const root = resolve(cwd);
  const force = f.force === true;
  const v: Record<string, string> = {
    version: VERSION,
    project: str(f, "project", root.split(/[\\/]/).pop()!)!,
    spec_agent: str(f, "spec-agent", "agent-a")!, spec_human: str(f, "spec-human", "human-a")!, spec_mode: str(f, "spec-mode", "agent_push")!,
    impl_agent: str(f, "impl-agent", "agent-b")!, impl_human: str(f, "impl-human", "human-b")!, impl_mode: str(f, "impl-mode", "human_commit")!,
    github_org: str(f, "github-org", "OWNER")!,
  };
  v.spec_human_gh = str(f, "spec-github", "CHANGE-ME")!;
  v.impl_human_gh = str(f, "impl-github", "CHANGE-ME")!;
  for (const m of [v.spec_mode, v.impl_mode]) if (!["agent_push", "human_commit"].includes(m)) throw new CliError(`mode must be agent_push | human_commit, got ${m}`);
  const written: string[] = [], skipped: string[] = [];
  const conv = join(root, "conversation");
  writeIfAbsent(join(conv, "config.yml"), fill(readText(templatePath("conversation", "config.yml")), v), force, written, skipped);
  writeIfAbsent(join(conv, "README.md"), fill(readText(templatePath("conversation", "README.md")), v), force, written, skipped);
  for (const n of ["ticket.md", "turn.md", "conclusion.md"])
    writeIfAbsent(join(conv, "_templates", n), readText(templatePath("conversation", "_templates", n)), force, written, skipped);
  for (const w of WORKFLOWS) writeIfAbsent(join(root, ".github", "workflows", w), fill(readText(templatePath("github", w)), v), force, written, skipped);
  const co = join(root, ".github", "CODEOWNERS");
  let snippet = fill(readText(templatePath("github", "CODEOWNERS.snippet")), v);
  const handlesSet = v.spec_human_gh !== "CHANGE-ME" && v.impl_human_gh !== "CHANGE-ME";
  if (handlesSet) snippet = snippet.replace(/^# collabkit: replace the handles.*$/m, "# collabkit: code owners (spec owner reviews rules; both sides own conversation/)");
  if (exists(co)) { writeText(join(root, ".github", "CODEOWNERS.collabkit"), snippet); written.push(join(root, ".github", "CODEOWNERS.collabkit") + "  (merge into your CODEOWNERS)"); }
  else { writeText(co, snippet); written.push(co); }
  const cfg = loadConfig(root);
  writeText(indexPath(root, cfg), renderIndex(root, cfg)); written.push(indexPath(root, cfg));
  const as = str(f, "as", v.spec_agent)!;
  writeText(join(root, ".collabkit", "local.yml"), YAML.stringify({ as }));
  ensureGitignore(root, [".collabkit/local.yml", ".collabkit/link.yml", ".claude/settings.local.json*"]);
  const integ = (str(f, "integration", "generic")!).split(",").map((s) => s.trim()).filter(Boolean);
  written.push(...installIntegrations(integ, { workRoot: root, specRoot: root, cfg, me: as, role: "spec-owner" }));
  writeManifest(root, written.filter((p) => !p.includes("(")));
  log(`collabkit ${VERSION} initialised ${relative(cwd, root) || "."} as ${as}`);
  for (const p of written) log(`  + ${relative(root, p.replace(/\s+\(.*$/, "")) + (p.includes("(") ? "  (merge into .github/CODEOWNERS)" : "")}`);
  for (const p of skipped) log(`  = ${relative(root, p)} (exists, kept; --force to overwrite)`);
  if (!isRepo(root)) log("\nnote: this folder is not a git repo yet - `git init` before using submit.");
  if (v.spec_human_gh === "CHANGE-ME") log("\nnote: pass --spec-github/--impl-github (or edit parties.*.github in config.yml) so CI can verify who pushed what.");
  log(handlesSet
    ? `\nNext: commit these files, invite the implementer (${v.impl_human_gh}) to this repo, protect the default branch if your plan allows it.`
    : `\nNext: replace GitHub handles in .github/CODEOWNERS, protect the default branch (require PR + code owner review),\ninvite the implementer, then commit these files.`);
}

const WORKFLOWS = ["collabkit-check.yml", "collabkit-automerge.yml", "collabkit-signals.yml"];

function writeManifest(root: string, files: string[]) {
  const m: Record<string, string> = {};
  for (const p of files) if (exists(p)) m[relative(root, p).split("\\").join("/")] = sha256(readText(p));
  writeText(join(root, ".collabkit", "manifest.json"), JSON.stringify({ collabkit: VERSION, files: m }, null, 2) + "\n");
}

export function cmdLink(cwd: string, pos: string[], f: Flags) {
  const work = resolve(cwd);
  const specArg = pos[0];
  if (!specArg) throw new CliError("usage: collab link <path-to-spec-repo> [--as agent-b] [--integration generic,claude]");
  const spec = resolve(work, specArg);
  if (!exists(join(spec, CONFIG_REL))) throw new CliError(`${spec} has no ${CONFIG_REL}`);
  const cfg = loadConfig(spec);
  const as = str(f, "as", cfg.parties.implementer.agent)!;
  const role: Role = cfg.parties["spec-owner"].agent === as || cfg.parties["spec-owner"].human === as ? "spec-owner" : "implementer";
  const specRel = relative(work, spec).split("\\").join("/");
  writeText(join(work, ".collabkit", "link.yml"), YAML.stringify({ spec_repo: specRel, as }));
  ensureGitignore(work, [".collabkit/link.yml", ".collabkit/local.yml", ".claude/settings.local.json*"]);
  const integ = (str(f, "integration", "generic")!).split(",").map((s) => s.trim()).filter(Boolean);
  const written = installIntegrations(integ, { workRoot: work, specRoot: spec, cfg, me: as, role });
  log(`linked ${relative(cwd, work) || "."} -> ${specRel} as ${as} (${role})`);
  for (const p of written) log(`  + ${relative(work, p)}`);
}

// ---------------------------------------------------------------- reading
export function cmdWhoami(ctx: Ctx) {
  const m = me(ctx);
  log(`${m.id}  ${m.kind}  ${m.role}  mode=${ctx.cfg.parties[m.role].mode}`);
  log(`spec repo: ${ctx.specRoot}`);
  if (ctx.workRoot !== ctx.specRoot) log(`work repo: ${ctx.workRoot}`);
}

/** Warn when the spec repo is on a stale branch or behind its upstream: the most common human slip. */
function freshness(root: string): string[] {
  if (!isRepo(root)) return [];
  const out: string[] = [];
  const base = git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], true).replace(/^origin\//, "") || "main";
  const branch = git(root, ["branch", "--show-current"], true);
  if (branch && branch !== base) out.push(`spec repo is on branch "${branch}", not "${base}". Before a new turn: git -C ${shp(root)} switch ${base} && git -C ${shp(root)} pull`);
  fetchQuiet(root, [], 8000);                     // skipped with COLLAB_NO_FETCH=1: then "behind" uses what is already known
  const behind = Number(git(root, ["rev-list", "--count", `HEAD..origin/${base}`], true) || 0);
  if (behind > 0) out.push(`spec repo is ${behind} commit(s) behind origin/${base}: git -C ${shp(root)} pull`);
  return out;
}

export function cmdInbox(ctx: Ctx, f: Flags) {
  const m = me(ctx);
  for (const w of freshness(ctx.specRoot)) log("WARN  " + w);
  const all = f.all === true;
  const ts = listTickets(ctx.specRoot, ctx.cfg).filter((t) => all || t.doc.data.waiting_for === m.id);
  if (!ts.length) { log(all ? "no tickets" : `nothing waiting for ${m.id}`); return; }
  for (const t of ts) {
    const d = t.doc.data;
    log(`${t.id}  ${String(d.level).padEnd(2)}  ${String(d.state).padEnd(10)}  waiting:${String(d.waiting_for).padEnd(10)}  turns:${t.turns.length}  ${d.title}`);
  }
}

// ---------------------------------------------------------------- writing
export function cmdOpen(ctx: Ctx, f: Flags) {
  const m = me(ctx);
  const level = need(f, "level").toUpperCase();
  if (levelIdx(level) < 0) throw new CliError(`--level must be ${LEVELS.join("|")}`);
  const requirement = need(f, "requirement");
  const weekAgo = Date.now() - 7 * 864e5;
  const mine = listTickets(ctx.specRoot, ctx.cfg).filter((t) => t.doc.data.opened_by === m.id && t.doc.data.level !== "T3" && Date.parse(t.doc.data.opened_at) >= weekAgo).length;
  if (level !== "T3" && mine >= ctx.cfg.max_new_tickets_per_week) throw new CliError(`weekly cap reached: ${m.id} opened ${mine} tickets in 7 days (max ${ctx.cfg.max_new_tickets_per_week})`);
  const id = nextId(ctx.specRoot, ctx.cfg);
  const parked = requirement === NO_REQUIREMENT;
  const now = nowIso();
  const text = fill(readText(templatePath("conversation", "_templates", "ticket.md")), {
    id, title: JSON.stringify(need(f, "title")), level, level_reason: JSON.stringify(need(f, "reason")),
    waiting_for: parked ? "none" : counterpartAgent(ctx.cfg, m.role), me: m.id, now,
    requirement: JSON.stringify(requirement), spec_ref: JSON.stringify(str(f, "spec-ref", "-")),
    code_changed: str(f, "code-changed", "no")!, running_at: str(f, "running-at", "none")!,
  });
  const doc = parse(text);
  if (parked) doc.data.state = "parked";
  if (str(f, "area")) doc.data.area = str(f, "area");
  const file = join(convDir(ctx.specRoot, ctx.cfg), id, "ticket.md");
  writeText(file, stringify(doc));
  writeText(indexPath(ctx.specRoot, ctx.cfg), renderIndex(ctx.specRoot, ctx.cfg));
  log(`opened ${id} -> ${relative(process.cwd(), file)}`);
  log(parked ? `requirement ${NO_REQUIREMENT}: parked immediately` : `waiting for ${doc.data.waiting_for}. Fill the sections, then \`collab check\` and \`collab submit ${id}\`.`);
}

export function cmdReply(ctx: Ctx, pos: string[], f: Flags) {
  const m = me(ctx);
  const t = getTicket(ctx, pos[0]);
  const st = t.doc.data.state as State;
  if (["rejected", "conformed"].includes(st)) throw new CliError(`${t.id} is ${st}; reopen with \`collab state ${t.id} discussing\` first`);
  const points = (str(f, "points", "P1")!).split(",").map((s) => s.trim()).filter(Boolean);
  if (t.turns.length >= ctx.cfg.max_turns_per_ticket)
    throw new CliError(`${t.id} already has ${t.turns.length} turns (max ${ctx.cfg.max_turns_per_ticket}). Run \`collab conclude ${t.id}\` and record the open points as options for the human.`);
  const known = new Set(t.turns.flatMap((x) => x.doc.data.points ?? []));
  for (const p of points) known.add(p);
  if (known.size > ctx.cfg.max_points_per_ticket)
    throw new CliError(`${t.id} would have ${known.size} points (max ${ctx.cfg.max_points_per_ticket}). Open a separate ticket for the new topic.`);
  const lastTurn = t.turns.at(-1);
  if (lastTurn && lastTurn.by !== m.id) {
    const st = Object.values(stances(lastTurn.doc.body));
    if (st.length && st.every((x) => x === "agree"))
      throw new CliError(`the last turn agrees on every point. Do not reply: \`collab conclude ${t.id}\`, write the conclusion, then \`collab sign ${t.id}\`.`);
  }
  for (const p of points) {
    const used = t.turns.filter((x) => x.by === m.id && (x.doc.data.points ?? []).includes(p)).length;
    if (used >= ctx.cfg.max_turns_per_point)
      throw new CliError(`you already used ${used}/${ctx.cfg.max_turns_per_point} turns on ${p}. Escalate: \`collab state ${t.id} discussing --level T2\` and record the options in the conclusion.`);
  }
  const n = (t.turns.at(-1)?.n ?? 0) + 1;
  if (n >= 99) throw new CliError("turn limit of the folder reached");
  const nn = String(n).padStart(2, "0");
  const file = join(t.dir, `${nn}-${m.id}.md`);
  const sections = points.map((p) => `### ${p} · <name>\n- agree | disagree | need data\n- reason + evidence\n`).join("\n");
  writeText(file, fill(readText(templatePath("conversation", "_templates", "turn.md")), { id: t.id, turn: nn, me: m.id, now: nowIso(), points: points.join(", "), point_sections: sections }));
  if (st === "open" || st === "parked" && f.reopen === true) t.doc.data.state = "discussing";
  t.doc.data.waiting_for = str(f, "waiting-for", m.kind === "agent" ? counterpartAgent(ctx.cfg, m.role) : t.doc.data.waiting_for);
  t.turns.push({ n, by: m.id, file, doc: parse(readText(file)) });
  save(ctx, t);
  log(`turn ${nn} -> ${relative(process.cwd(), file)}; waiting for ${t.doc.data.waiting_for}`);
  log("Now write the reply in that file (one section per point). `collab check` fails while it still holds the template.");
}

export function cmdConclude(ctx: Ctx, pos: string[]) {
  const m = me(ctx);
  const t = getTicket(ctx, pos[0]);
  if (!exists(t.conclusionFile)) writeText(t.conclusionFile, fill(readText(templatePath("conversation", "_templates", "conclusion.md")), { id: t.id }));
  if (t.doc.data.state === "open") t.doc.data.state = "discussing";
  if (m.kind === "agent") t.doc.data.waiting_for = counterpartAgent(ctx.cfg, m.role);
  save(ctx, t);
  log(`conclusion -> ${relative(process.cwd(), t.conclusionFile)}. Write it, then \`collab sign ${t.id}\`.`);
}

export function cmdSign(ctx: Ctx, pos: string[]) {
  const m = me(ctx);
  if (m.kind !== "agent") throw new CliError("only agents sign the conclusion; humans use `collab decide`");
  const t = getTicket(ctx, pos[0]);
  if (!exists(t.conclusionFile)) throw new CliError(`no ${CONCLUSION}; run \`collab conclude ${t.id}\``);
  const c = parse(readText(t.conclusionFile));
  if (/^## Conclusion\s*\n\s*(## |$)/m.test(c.body)) throw new CliError(`write the conclusion in ${CONCLUSION} before signing`);
  const h = conclusionHash(c.body);
  c.data.signatures = { ...(c.data.signatures ?? {}), [m.id]: { at: nowIso(), sha256: h } };
  writeText(t.conclusionFile, stringify(c));
  const valid = (a: string) => { const s = readSig(c.data.signatures[a]); return !!s && !s.legacy && s.sha256 === h; };
  const stale = Object.keys(c.data.signatures).filter((a) => a !== m.id && !valid(a));
  const both = [ctx.cfg.parties["spec-owner"].agent, ctx.cfg.parties.implementer.agent].every(valid);
  if (stale.length) log(`note: the conclusion text differs from what ${stale.join(", ")} signed; they must sign again`);
  if (both) {
    t.doc.data.state = "agreed";
    t.doc.data.waiting_for = decider(ctx.cfg, t.doc.data.level);
  } else t.doc.data.waiting_for = counterpartAgent(ctx.cfg, m.role);
  save(ctx, t);
  log(both ? `${t.id} agreed; waiting for decision by ${t.doc.data.waiting_for}` : `signed; waiting for ${t.doc.data.waiting_for} to sign`);
}

export function cmdDecide(ctx: Ctx, pos: string[], f: Flags) {
  const m = me(ctx);
  if (m.kind !== "human") throw new CliError("only a human decides");
  if (!pos.length) throw new CliError('usage: collab decide <ID>[=option] [<ID>[=option] ...] --decision approve|park|reject [--option O] [--note N]');
  const decision = need(f, "decision");
  const map: Record<string, State> = { approve: "approved", park: "parked", reject: "rejected" };
  if (!map[decision]) throw new CliError("--decision approve|park|reject");
  // validate everything first, write nothing on error
  const items = pos.map((arg) => {
    const i = arg.indexOf("=");
    const id = normId(ctx.cfg, i < 0 ? arg : arg.slice(0, i));
    const option = i < 0 ? str(f, "option") : arg.slice(i + 1);
    const t = getTicket(ctx, id);
    const d = t.doc.data;
    if (levelIdx(d.level) >= 2 && m.role !== "spec-owner") throw new CliError(`${t.id}: ${d.level} is decided by ${ctx.cfg.parties["spec-owner"].human}`);
    if (!TRANSITIONS[d.state as State].includes(map[decision])) throw new CliError(`${t.id}: cannot ${decision} a ticket in state ${d.state}`);
    return { t, option };
  });
  for (const { t, option } of items) {
    const d = t.doc.data;
    d.decision = { by: m.id, decision, at: nowIso(), ...(option ? { option } : {}), ...(str(f, "note") ? { note: str(f, "note") } : {}) };
    d.state = map[decision];
    d.waiting_for = decision !== "approve" ? "none" : levelIdx(d.level) >= 2 || m.role === "spec-owner" ? ctx.cfg.parties["spec-owner"].agent : ctx.cfg.parties.implementer.agent;
    save(ctx, t);
    log(`${t.id} ${d.state}${option ? ` (${option})` : ""}; waiting for ${d.waiting_for}`);
  }
}

export function cmdState(ctx: Ctx, pos: string[], f: Flags) {
  const m = me(ctx);
  const t = getTicket(ctx, pos[0]);
  const d = t.doc.data;
  const to = (pos[1] ?? d.state) as State;
  if (!STATES.includes(to)) throw new CliError(`state must be one of ${STATES.join(", ")}`);
  const newLevel = str(f, "level")?.toUpperCase();
  if (newLevel) {
    if (levelIdx(newLevel) < 0) throw new CliError(`--level must be ${LEVELS.join("|")}`);
    if (levelIdx(newLevel) < levelIdx(d.level)) {
      if (m.kind !== "human") throw new CliError("agents may only raise a level");
      d.level_override_by = m.id;
    }
    d.level = newLevel;
    if (str(f, "reason")) d.level_reason = str(f, "reason");
  }
  if (to !== d.state) {
    if (!TRANSITIONS[d.state as State].includes(to)) throw new CliError(`invalid transition ${d.state} -> ${to}`);
    if (["approved", "parked", "rejected"].includes(to)) throw new CliError("use `collab decide` for approve/park/reject");
    if (to === "in-spec") {
      const owner = ctx.cfg.parties["spec-owner"].human;
      if (d.decision?.by !== owner)
        throw new CliError(`a spec change needs a decision by ${owner} (now: ${d.decision?.by ?? "none"}). Ask ${owner} to \`collab decide ${t.id} --decision approve\`.`);
      d.spec_change_ref = need(f, "ref"); d.waiting_for = ctx.cfg.parties.implementer.agent;
    }
    if (to === "conformed") {
      if (levelIdx(d.level) >= 2 && d.state !== "in-spec" && d.state !== "approved") throw new CliError("T2/T3 must be approved first");
      d.conformed_ref = need(f, "ref"); d.waiting_for = "none";
    }
    if (to === "discussing") d.waiting_for = m.kind === "agent" ? counterpartAgent(ctx.cfg, m.role) : d.waiting_for;
    d.state = to;
  }
  save(ctx, t);
  log(`${t.id} ${d.state} ${d.level}; waiting for ${d.waiting_for}`);
}

export function cmdIndex(ctx: Ctx) {
  const p = indexPath(ctx.specRoot, ctx.cfg);
  writeText(p, renderIndex(ctx.specRoot, ctx.cfg));
  log(`wrote ${relative(process.cwd(), p)}`);
}

export function cmdCheck(ctx: Ctx, f: Flags): number {
  const ds = check(ctx.specRoot, ctx.cfg, { base: str(f, "base"), pr: f.pr === true, actor: str(f, "actor") || process.env.COLLAB_ACTOR || undefined });
  if (f.json === true) log(JSON.stringify({ ok: !ds.some((d) => d.severity === "error"), diagnostics: ds }, null, 2));
  else log(formatDiags(ds));
  return ds.some((d) => d.severity === "error") ? 1 : 0;
}

export function cmdSubmit(ctx: Ctx, pos: string[], f: Flags) {
  const m = me(ctx);
  const root = ctx.specRoot;
  if (!isRepo(root)) throw new CliError(`${root} is not a git repo`);
  const ds = check(root, ctx.cfg, {});
  const errors = ds.filter((d) => d.severity === "error");
  if (errors.length) throw new CliError("check failed - fix before submit:\n" + formatDiags(errors));
  const changed = changedSince(root, "HEAD");
  const conv = changed.filter((c) => c.path.startsWith(ctx.cfg.folder + "/"));
  if (!conv.length) throw new CliError("nothing to submit under " + ctx.cfg.folder + "/");
  const outside = changed.filter((c) => !c.path.startsWith(ctx.cfg.folder + "/")).map((c) => `${c.status} ${c.path}`);
  const touched = [...new Set(conv.map((c) => c.path.split("/")[1]).filter((n) => /^[A-Z]+-\d{3,}$/.test(n)))].sort();
  const ids = pos.length ? pos.map((p) => normId(ctx.cfg, p)) : touched;
  const label = ids.length === 0 ? "conversation" : ids.length === 1 ? ids[0] : `${ids[0]}..${ids.at(-1)!.split("-").pop()}`;
  const states = ids.map((id) => `${id} ${loadTicket(root, ctx.cfg, id)?.doc.data.state ?? "?"}`);
  const stamp = nowIso().slice(0, 16).replace(/[-:T]/g, "");
  const branch = `conv/${label.replace(/\.\./g, "-")}-${m.id}-${stamp}`;
  const msg = `collab(${label}): ${states.length === 1 ? states[0].split(" ")[1] : "update"} by ${m.id}`;
  const body = `${states.join("\n")}\n\nAgent: ${m.id}`;
  const base = git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], true).replace(/^origin\//, "") || "main";
  const hasRemote = git(root, ["remote"], true).split("\n").includes("origin");
  const compare = compareUrl(root, base, branch);
  const R = shp(root);
  const steps = [
    `git -C ${R} switch -c ${branch}`,
    `git -C ${R} add ${ctx.cfg.folder}`,
    `git -C ${R} commit -m "${msg}" -m "Agent: ${m.id}"`,
    `git -C ${R} push -u origin ${branch}`,
    hasCommand("gh")
      ? `gh pr create --repo "$(git -C ${R} remote get-url origin)" --base ${base} --head ${branch} --title "${msg}" --body "Agent: ${m.id}"`
      : `# open the PR in a browser: ${compare ?? `GitHub > New pull request > ${branch} into ${base}`}`,
  ];
  const mode: Mode = ctx.cfg.parties[m.role].mode;
  const ship = f.ship === true;
  // ship/submit carry ticket work only. Tool upgrades, spec edits and code are committed by hand, under the
  // human's name - never half-committed under an agent's name (seen after `collab upgrade` in 0.3.0).
  if (outside.length)
    throw new CliError(`not a ticket change: ${outside.length} file(s) outside ${ctx.cfg.folder}/:\n  ${outside.join("\n  ")}\n` +
      `Commit those by hand on their own branch (e.g. after \`collab upgrade\`), or set them aside (git stash) and ship again.`);
  if (!touched.length)
    throw new CliError(`no ticket changed: only ${conv.map((c) => c.path).join(", ")}. Rule, config or template changes are not shipped by collab: commit them by hand.`);
  if (f["dry-run"] === true) { log("dry run - would run:\n"); for (const s of steps) log("  " + s); return; }
  if (!ship && m.kind === "agent" && mode === "human_commit") {
    log(`Ready. ${m.id} is in human_commit mode: ${ctx.cfg.parties[m.role].human}, run this in your terminal:\n`);
    log(`  collab ship${pos.length ? " " + pos.join(" ") : ""}\n`);
    log("(it creates the branch, commits, pushes and prints the PR link)");
    return;
  }
  git(root, ["switch", "-c", branch]);
  git(root, ["add", ctx.cfg.folder]);
  git(root, ["-c", "maintenance.auto=false", "-c", "gc.auto=0", "commit", "-m", msg, "-m", `Agent: ${m.id}`]);
  log(`committed on ${branch}`);
  if (!hasRemote) { log("no `origin` remote: branch kept locally, no PR opened"); return; }
  git(root, ["push", "-u", "origin", branch]);
  log(`pushed ${branch}`);
  if (!hasCommand("gh")) { log(`gh CLI not found. Open the PR: ${compare ?? `${branch} into ${base}`}`); return; }
  try {
    const url = execFileSync("gh", ["pr", "create", "--base", base, "--head", branch, "--title", msg, "--body", body], { cwd: root, encoding: "utf8" }).trim();
    log(`PR: ${url}`);
  } catch (e: any) { log(`PR not opened automatically (${(e.stderr ?? e.message).toString().trim()}). Open one from ${branch} into ${base}.`); }
}

/** https://github.com/<owner>/<repo>/compare/<base>...<branch>?expand=1 for GitHub remotes (https or ssh). */
function compareUrl(root: string, base: string, branch: string): string | undefined {
  const url = git(root, ["remote", "get-url", "origin"], true);
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(\.git)?$/.exec(url);
  return m ? `https://github.com/${m[1]}/${m[2]}/compare/${base}...${branch}?expand=1` : undefined;
}

// ---------------------------------------------------------------- next
/** What should <me> do now? One line per ticket, with the exact command. Agents run this at session start. */
export function cmdNext(ctx: Ctx, f: Flags) {
  const m = me(ctx);
  const C = "collab";
  for (const w of freshness(ctx.specRoot)) log("WARN  " + w);
  const owner = ctx.cfg.parties["spec-owner"];
  const impl = ctx.cfg.parties.implementer;
  const mine = listTickets(ctx.specRoot, ctx.cfg).filter((t) => t.doc.data.waiting_for === m.id);
  if (!mine.length) { log(`nothing waiting for ${m.id}.`); return; }
  for (const t of mine) {
    const d = t.doc.data;
    const id = t.id;
    const conv = shp(t.dir);
    const steps: string[] = [];
    const sigs = t.conclusion?.data.signatures ?? {};
    const h = t.conclusion ? conclusionHash(t.conclusion.body) : "";
    const myValid = (() => { const s = readSig(sigs[m.id]); return !!s && !s.legacy && s.sha256 === h; })();
    const last = t.turns.at(-1);
    const allAgree = !!last && last.by !== m.id && (() => { const st = Object.values(stances(last.doc.body)); return st.length > 0 && st.every((x) => x === "agree"); })();
    switch (d.state) {
      case "open": case "discussing":
        if (m.kind !== "agent") { steps.push(`waiting on you as a human: read ${conv} and tell your agent what to do`); break; }
        if (t.conclusion && !myValid) steps.push(`read ${shp(t.conclusionFile)}; if it is fair: ${C} sign ${id} (do not edit it; disagree? say so in a turn)`);
        else if (allAgree || t.turns.length >= ctx.cfg.max_turns_per_ticket) steps.push(`${C} conclude ${id}`, `write ${shp(t.conclusionFile)}: conclusion, open disagreements as options, rejected alternatives`, `${C} sign ${id}`);
        else steps.push(`read the ticket and the last turn in ${conv}`, `${C} reply ${id} --points P1[,P2]`, "write the new turn file: one section per point, agree | disagree | need data, reasons, sources (or \"not verified\")",
          "if every point is agreed, conclude instead of replying");
        break;
      case "agreed":
        steps.push(`read the options in ${shp(t.conclusionFile)} (Open disagreements)`, `${C} decide ${id}=<option> --decision approve|park|reject`);
        break;
      case "approved":
        if (m.id === owner.agent) steps.push(`change the spec in a separate PR (spec files only), per decision "${d.decision?.option ?? ""}"`, "after merge, the spec owner tags it: git tag vX.Y.Z && git push origin refs/tags/vX.Y.Z", `then: ${C} state ${id} in-spec --ref vX.Y.Z`);
        else steps.push(`implement the decision "${d.decision?.option ?? ""}" in code (code-only fix)`, `${C} state ${id} conformed --ref <spec tag the code follows>`);
        break;
      case "in-spec":
        steps.push(`build against spec ${d.spec_change_ref}: update SPEC_VERSION, code, tests; merge the code PR first`, `then: ${C} state ${id} conformed --ref ${d.spec_change_ref}`);
        break;
      default:
        steps.push(`state ${d.state}: nothing to do`);
    }
    log(`${id}  ${d.level}  ${d.state}  ${d.title}`);
    steps.forEach((s, i) => log(`  ${i + 1}. ${s}`));
  }
  log("");
  const humanShips = ctx.cfg.parties[m.role].mode === "human_commit" && m.kind === "agent";
  log(humanShips
    ? `when done: ${C} check, then tell ${ctx.cfg.parties[m.role].human} to run \`collab ship\` (you never run git or ship)`
    : `when done: ${C} ship   (checks, commits, pushes, prints the PR link)`);
  void impl; void f;
}

// ---------------------------------------------------------------- upgrade
/** Bring files collabkit manages up to this version. Never touches tickets; keeps edited files unless --force. */
export function cmdUpgrade(cwd: string, f: Flags) {
  const dry = f["dry-run"] === true, force = f.force === true;
  const changes: string[] = [];
  const write = (p: string, s: string, why: string) => { if (exists(p) && readText(p) === s) return; changes.push(`${relative(cwd, p)}  ${why}`); if (!dry) writeText(p, s); };
  let ctx: Ctx;
  try { ctx = loadCtx(cwd, undefined, false); } catch (e) { throw e; }
  const { specRoot, workRoot, cfg } = ctx;
  const isSpecSide = specRoot === workRoot;
  if (isSpecSide) {
    const manifest = exists(join(specRoot, ".collabkit/manifest.json")) ? JSON.parse(readText(join(specRoot, ".collabkit/manifest.json"))).files ?? {} : {};
    // workflows: add new ones, replace untouched ones, repin edited ones
    for (const w of WORKFLOWS) {
      const rel = `.github/workflows/${w}`;
      const wf = join(specRoot, rel);
      const fresh = fill(readText(templatePath("github", w)), { version: VERSION });
      if (!exists(wf)) { write(wf, fresh, "added"); continue; }
      const cur = readText(wf);
      // "untouched" = equal to a shipped template once version pins are ignored (users repin by hand)
      const norm = (x: string) => x.replace(/collabkit(-cli@| )\d+\.\d+\.\d+/g, "collabkit$1X").trim();
      const shipped = [readText(templatePath("github", w)), ...(w === "collabkit-check.yml" ? [readText(templatePath("github", "legacy", "collabkit-check.v0.yml"))] : [])];
      const pristine = shipped.some((t) => norm(t.replace(/\{\{version\}\}/g, "0.0.0")) === norm(cur));
      const edited = !pristine && manifest[rel] && sha256(cur) !== manifest[rel];
      if (!edited || force) write(wf, fresh, "workflow -> " + VERSION);
      else { const repinned = cur.replace(/collabkit-cli@\d+\.\d+\.\d+/g, `collabkit-cli@${VERSION}`); write(wf, repinned, "repinned to " + VERSION + " (file was edited by hand; kept the rest)"); }
    }
    // README: managed block between markers
    const rd = join(specRoot, cfg.folder, "README.md");
    if (exists(rd)) {
      const p = cfg.parties;
      const vars = { version: VERSION, spec_agent: p["spec-owner"].agent, spec_human: p["spec-owner"].human, spec_mode: p["spec-owner"].mode,
        impl_agent: p.implementer.agent, impl_human: p.implementer.human, impl_mode: p.implementer.mode };
      const tpl = fill(readText(templatePath("conversation", "README.md")), vars);
      const block = /<!-- collabkit:start -->[\s\S]*?<!-- collabkit:end -->/;
      const cur = readText(rd);
      const nb = tpl.match(block)?.[0];
      if (nb && block.test(cur)) write(rd, cur.replace(block, nb), "rules block");
    }
    // templates: replace when untouched
    for (const n of ["ticket.md", "turn.md", "conclusion.md"]) {
      const dst = join(specRoot, cfg.folder, "_templates", n);
      const rp = `${cfg.folder}/_templates/${n}`;
      const fresh = readText(templatePath("conversation", "_templates", n));
      if (!exists(dst)) { write(dst, fresh, "added"); continue; }
      const edited = manifest[rp] && sha256(readText(dst)) !== manifest[rp];
      if (edited && !force) { changes.push(`${relative(cwd, dst)}  kept (edited by hand; --force to replace)`); continue; }
      write(dst, fresh, "template");
    }
    // config: add keys introduced since the repo was set up, keep comments
    const cp = join(specRoot, CONFIG_REL);
    const doc = YAML.parseDocument(readText(cp));
    const defaults: Record<string, any> = { max_turns_per_ticket: 6, max_points_per_ticket: 5, autonomy: "manual", activity_log: "off" };
    for (const [k, v] of Object.entries(defaults)) if (!doc.has(k)) doc.set(k, v);
    for (const r of ["spec-owner", "implementer"]) if (!doc.hasIn(["parties", r, "github"])) doc.setIn(["parties", r, "github"], f[`${r === "spec-owner" ? "spec" : "impl"}-github`] ?? "CHANGE-ME");
    write(cp, doc.toString(), "config keys");
  }
  // integrations: refresh what is installed in the work repo
  const present: string[] = [];
  if (exists(join(workRoot, "AGENTS.md")) && readText(join(workRoot, "AGENTS.md")).includes("collabkit:start")) present.push("generic");
  if (exists(join(workRoot, ".claude/skills/collabkit/SKILL.md")) || (exists(join(workRoot, "CLAUDE.md")) && readText(join(workRoot, "CLAUDE.md")).includes("collabkit:start"))) present.push("claude");
  if (present.length && !dry) {
    const meId = ctx.me?.id ?? (isSpecSide ? cfg.parties["spec-owner"].agent : cfg.parties.implementer.agent);
    const role = ctx.me?.role ?? (isSpecSide ? "spec-owner" : "implementer");
    const files = [join(workRoot, "AGENTS.md"), join(workRoot, "CLAUDE.md"), join(workRoot, ".claude/skills/collabkit/SKILL.md")];
    const snap = files.map((p) => (exists(p) ? readText(p) : undefined));
    installIntegrations(present, { workRoot, specRoot, cfg, me: meId, role });
    const changed = files.filter((p, i) => (exists(p) ? readText(p) : undefined) !== snap[i]).map((p) => relative(cwd, p));
    if (changed.length) changes.push(`agent files refreshed: ${changed.join(", ")}`);
  } else if (present.length) changes.push(`agent files would be refreshed: ${present.join(", ")}`);
  if (isSpecSide && !dry) {
    writeText(indexPath(specRoot, cfg), renderIndex(specRoot, cfg));
    const files = [...WORKFLOWS.map((w) => `.github/workflows/${w}`), `${cfg.folder}/README.md`, ...["ticket.md", "turn.md", "conclusion.md"].map((n) => `${cfg.folder}/_templates/${n}`)].map((r) => join(specRoot, r));
    writeManifest(specRoot, files);
  }
  log(`collabkit ${VERSION} upgrade${dry ? " (dry run)" : ""}: ${changes.length ? "" : "already up to date"}`);
  for (const c of changes) log("  ~ " + c);
  if (isSpecSide && changes.some((c) => c.includes("config keys"))) log("\nCheck conversation/config.yml: set parties.*.github to the real GitHub logins (used to verify who pushed what).");
  if (!dry && changes.length) log("Commit these changes in their own PR.");
}

// ---------------------------------------------------------------- sync
/** Put the spec repo on its default branch, up to date. Refuses when there are uncommitted changes. */
export function cmdSync(ctx: Ctx) {
  const root = ctx.specRoot;
  if (!isRepo(root)) throw new CliError(`${shp(root)} is not a git repo`);
  const dirty = git(root, ["status", "--porcelain", "--", ctx.cfg.folder], true);
  const base = git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], true).replace(/^origin\//, "") || "main";
  const branch = git(root, ["branch", "--show-current"], true);
  if (dirty) {
    throw new CliError(`uncommitted changes in ${ctx.cfg.folder}/ on "${branch}". Ship them first (\`collab ship\`), or set them aside: git -C ${shp(root)} stash -u`);
  }
  if (branch !== base) { git(root, ["switch", base]); log(`switched ${shp(root)} to ${base}`); }
  const hasRemote = git(root, ["remote"], true).split("\n").includes("origin");
  if (hasRemote) {
    try { execFileSync("git", ["-c", "maintenance.auto=false", "-c", "gc.auto=0", "pull", "--ff-only", "--quiet"], { cwd: root, stdio: ["ignore", "ignore", "pipe"] }); }
    catch (e: any) { throw new CliError(`git pull failed in ${shp(root)}: ${(e.stderr ?? e.message).toString().trim()}`); }
  }
  log(`${shp(root)} is on ${base}, up to date${hasRemote ? "" : " (no remote)"}.`);
  // merged conv/* branches are noise; list them so the human can delete when they like
  const stale = git(root, ["branch", "--merged", base, "--list", "conv/*", "decide/*", "spec-*"], true).split("\n").map((x) => x.trim()).filter(Boolean);
  if (stale.length) log(`merged local branches you can delete: git -C ${shp(root)} branch -d ${stale.join(" ")}`);
}
