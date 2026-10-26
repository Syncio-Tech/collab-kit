import YAML from "yaml";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { Config, Mode, Role, counterpartAgent, loadConfig, CONFIG_REL } from "./core/config.js";
import { Ctx, loadCtx } from "./core/context.js";
import { parse, stringify } from "./core/frontmatter.js";
import { changedSince, git, hasCommand, isRepo } from "./core/git.js";
import { indexPath, renderIndex } from "./core/indexmd.js";
import { INTEGRATIONS, installIntegrations } from "./core/integrations.js";
import { check, formatDiags, TRANSITIONS } from "./core/rules.js";
import { CONCLUSION, LEVELS, NO_REQUIREMENT, STATES, State, Ticket, convDir, levelIdx, listTickets, loadTicket, nextId, rel } from "./core/ticket.js";
import { CliError, VERSION, exists, fill, nowIso, readText, sha256, templatePath, writeText } from "./core/util.js";

export type Flags = Record<string, string | boolean>;
const str = (f: Flags, k: string, d?: string): string | undefined => (typeof f[k] === "string" ? (f[k] as string) : d);
const need = (f: Flags, k: string): string => { const v = str(f, k); if (!v) throw new CliError(`--${k} is required`); return v; };
const log = (s = "") => process.stdout.write(s + "\n");

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

function getTicket(ctx: Ctx, id: string | undefined): Ticket {
  if (!id) throw new CliError("ticket id required, e.g. SYNC-001");
  const t = loadTicket(ctx.specRoot, ctx.cfg, id.toUpperCase());
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
  v.spec_human_gh = str(f, "spec-github", v.spec_human)!;
  v.impl_human_gh = str(f, "impl-github", v.impl_human)!;
  for (const m of [v.spec_mode, v.impl_mode]) if (!["agent_push", "human_commit"].includes(m)) throw new CliError(`mode must be agent_push | human_commit, got ${m}`);
  const written: string[] = [], skipped: string[] = [];
  const conv = join(root, "conversation");
  writeIfAbsent(join(conv, "config.yml"), fill(readText(templatePath("conversation", "config.yml")), v), force, written, skipped);
  writeIfAbsent(join(conv, "README.md"), fill(readText(templatePath("conversation", "README.md")), v), force, written, skipped);
  for (const n of ["ticket.md", "turn.md", "conclusion.md"])
    writeIfAbsent(join(conv, "_templates", n), readText(templatePath("conversation", "_templates", n)), force, written, skipped);
  writeIfAbsent(join(root, ".github", "workflows", "collabkit-check.yml"), fill(readText(templatePath("github", "collabkit-check.yml")), v), force, written, skipped);
  const co = join(root, ".github", "CODEOWNERS");
  const snippet = fill(readText(templatePath("github", "CODEOWNERS.snippet")), v);
  if (exists(co)) { writeText(join(root, ".github", "CODEOWNERS.collabkit"), snippet); written.push(join(root, ".github", "CODEOWNERS.collabkit") + "  (merge into your CODEOWNERS)"); }
  else { writeText(co, snippet); written.push(co); }
  const cfg = loadConfig(root);
  writeText(indexPath(root, cfg), renderIndex(root, cfg)); written.push(indexPath(root, cfg));
  const as = str(f, "as", v.spec_agent)!;
  writeText(join(root, ".collabkit", "local.yml"), YAML.stringify({ as }));
  ensureGitignore(root, [".collabkit/local.yml", ".collabkit/link.yml"]);
  const integ = (str(f, "integration", "generic")!).split(",").map((s) => s.trim()).filter(Boolean);
  written.push(...installIntegrations(integ, { workRoot: root, specRoot: root, cfg, me: as, role: "spec-owner" }));
  writeManifest(root, written.filter((p) => !p.includes("(")));
  log(`collabkit ${VERSION} initialised ${relative(cwd, root) || "."} as ${as}`);
  for (const p of written) log(`  + ${relative(root, p.replace(/\s+\(.*$/, "")) + (p.includes("(") ? "  (merge into .github/CODEOWNERS)" : "")}`);
  for (const p of skipped) log(`  = ${relative(root, p)} (exists, kept; --force to overwrite)`);
  if (!isRepo(root)) log("\nnote: this folder is not a git repo yet - `git init` before using submit.");
  log(`\nNext: replace GitHub handles in .github/CODEOWNERS, protect the default branch (require PR + code owner review),\ninvite the implementer, then commit these files.`);
}

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
  ensureGitignore(work, [".collabkit/link.yml", ".collabkit/local.yml"]);
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

export function cmdInbox(ctx: Ctx, f: Flags) {
  const m = me(ctx);
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
  c.data.signatures = { ...(c.data.signatures ?? {}), [m.id]: nowIso() };
  writeText(t.conclusionFile, stringify(c));
  const both = [ctx.cfg.parties["spec-owner"].agent, ctx.cfg.parties.implementer.agent].every((a) => c.data.signatures[a]);
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
  const t = getTicket(ctx, pos[0]);
  const d = t.doc.data;
  const decision = need(f, "decision");
  const map: Record<string, State> = { approve: "approved", park: "parked", reject: "rejected" };
  if (!map[decision]) throw new CliError("--decision approve|park|reject");
  if (levelIdx(d.level) >= 2 && m.role !== "spec-owner") throw new CliError(`${d.level} is decided by ${ctx.cfg.parties["spec-owner"].human}`);
  if (!TRANSITIONS[d.state as State].includes(map[decision])) throw new CliError(`cannot ${decision} a ticket in state ${d.state}`);
  d.decision = { by: m.id, decision, at: nowIso(), ...(str(f, "option") ? { option: str(f, "option") } : {}), ...(str(f, "note") ? { note: str(f, "note") } : {}) };
  d.state = map[decision];
  d.waiting_for = decision !== "approve" ? "none" : levelIdx(d.level) >= 2 ? ctx.cfg.parties["spec-owner"].agent : ctx.cfg.parties.implementer.agent;
  save(ctx, t);
  log(`${t.id} ${d.state}; waiting for ${d.waiting_for}`);
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
    if (to === "in-spec") { d.spec_change_ref = need(f, "ref"); d.waiting_for = ctx.cfg.parties.implementer.agent; }
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
  const ds = check(ctx.specRoot, ctx.cfg, { base: str(f, "base"), pr: f.pr === true });
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
  const guess = conv.map((c) => c.path.split("/")[1]).find((n) => /^[A-Z]+-\d{3,}$/.test(n));
  const id = (pos[0] ?? guess ?? "conversation").toUpperCase();
  const t = loadTicket(root, ctx.cfg, id);
  const stamp = nowIso().slice(0, 16).replace(/[-:T]/g, "");
  const branch = `conv/${id}-${m.id}-${stamp}`;
  const msg = `collab(${id}): ${t?.doc.data.state ?? "update"} by ${m.id}`;
  const body = `${t?.doc.data.title ?? ""}\n\nAgent: ${m.id}`;
  const base = git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], true).replace(/^origin\//, "") || "main";
  const hasRemote = git(root, ["remote"], true).split("\n").includes("origin");
  const steps = [
    `git -C ${root} switch -c ${branch}`,
    `git -C ${root} add ${ctx.cfg.folder}`,
    `git -C ${root} commit -m "${msg}" -m "Agent: ${m.id}"`,
    `git -C ${root} push -u origin ${branch}`,
    `gh pr create --repo "$(git -C ${root} remote get-url origin)" --base ${base} --head ${branch} --title "${msg}" --body "Agent: ${m.id}"`,
  ];
  const mode: Mode = ctx.cfg.parties[m.role].mode;
  if (outside.length) log(`note: changes outside ${ctx.cfg.folder}/ are left out of this commit:\n  ${outside.join("\n  ")}`);
  if ((m.kind === "agent" && mode === "human_commit") || f["dry-run"] === true) {
    log(`${m.id} is in human_commit mode${f["dry-run"] === true ? " (dry run)" : ""}. Ask ${ctx.cfg.parties[m.role].human} to run:\n`);
    for (const s of steps) log("  " + s);
    return;
  }
  git(root, ["switch", "-c", branch]);
  git(root, ["add", ctx.cfg.folder]);
  git(root, ["commit", "-m", msg, "-m", `Agent: ${m.id}`]);
  log(`committed on ${branch}`);
  if (!hasRemote) { log("no `origin` remote: branch kept locally, no PR opened"); return; }
  git(root, ["push", "-u", "origin", branch]);
  log(`pushed ${branch}`);
  if (!hasCommand("gh")) { log(`gh CLI not found: open a PR from ${branch} into ${base}.`); return; }
  try {
    const url = execFileSync("gh", ["pr", "create", "--base", base, "--head", branch, "--title", msg, "--body", body], { cwd: root, encoding: "utf8" }).trim();
    log(`PR: ${url}`);
  } catch (e: any) { log(`PR not opened automatically (${(e.stderr ?? e.message).toString().trim()}). Open one from ${branch} into ${base}.`); }
}
