// End-to-end: spec repo (A, agent_push) + clone for B (human_commit) + B's code repo linked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, appendFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const sh = (cwd, cmd, args) => execFileSync(cmd, args, { cwd, encoding: "utf8" });
const ck = (cwd, ...args) => {
  const r = spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
};
const ok = (cwd, ...args) => { const r = ck(cwd, ...args); assert.equal(r.code, 0, r.out); return r.out; };
const gitc = (cwd, ...a) => sh(cwd, "git", a);
const ckE = (cwd, env, ...args) => {
  const base = { ...process.env }; delete base.CLAUDECODE;           // tests run as a human unless a case says otherwise
  const r = spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8", env: { ...base, ...env } });
  return { code: r.status, out: r.stdout + r.stderr };
};
const okE = (cwd, env, ...args) => { const r = ckE(cwd, env, ...args); assert.equal(r.code, 0, r.out); return r.out; };
// write real content into a generated turn / ticket (what an agent must do)
const fillTurn = (file) => writeFileSync(file, readFileSync(file, "utf8")
  .replace(/<name>/g, "scope").replace("- agree | disagree | need data", "- disagree").replace("- reason + evidence", "- evidence: run 2026-10-27 shows 0 rows"));
const fillTicket = (file) => writeFileSync(file, readFileSync(file, "utf8")
  .replace("## Problem\n", "## Problem\nThe gate cannot be measured.\n").replace("## Evidence\n", "## Evidence\nQuery returns 0 rows.\n"));
const fillConclusion = (file) => writeFileSync(file, readFileSync(file, "utf8")
  .replace("## Conclusion\n", "## Conclusion\nBoth sides agree on option A.\n"));
const agreeTurn = (file) => writeFileSync(file, readFileSync(file, "utf8")
  .replace(/<name>/g, "scope").replace("- agree | disagree | need data", "- agree").replace("- reason + evidence", "- same reading of spec/REQ.md#REQ-002"));
const lastTurn = (dir) => { const fs = readdirSync(dir).filter((n) => /^\d\d-/.test(n) && n !== "99-conclusion.md").sort(); return join(dir, fs.at(-1)); };
const id = (dir, name) => { gitc(dir, "config", "user.email", `${name}@x`); gitc(dir, "config", "user.name", name); };

function setup() {
  const T = mkdtempSync(join(tmpdir(), "collabkit-"));
  const remote = join(T, "remote.git"), specA = join(T, "spec-a"), specB = join(T, "spec-b"), code = join(T, "code-b");
  sh(T, "git", ["init", "-q", "--bare", "-b", "main", remote]);
  sh(T, "git", ["init", "-q", "-b", "main", specA]); id(specA, "A");
  gitc(specA, "remote", "add", "origin", remote);
  ok(specA, "init", "--project", "demo", "--integration", "generic,claude");
  gitc(specA, "add", "-A"); gitc(specA, "commit", "-qm", "init"); gitc(specA, "push", "-q", "-u", "origin", "main");
  sh(T, "git", ["clone", "-q", remote, specB]); id(specB, "B");
  sh(T, "git", ["init", "-q", "-b", "main", code]);
  ok(code, "link", "../spec-b", "--integration", "claude");
  return { T, remote, specA, specB, code };
}

// merge a branch into main on the remote, the way an approved PR would
function mergeOnRemote(env, repo, branch) {
  gitc(repo, "fetch", "-q", "origin");
  gitc(repo, "switch", "-q", "main"); gitc(repo, "pull", "-q", "origin", "main");
  gitc(repo, "merge", "-q", "--no-ff", "-m", `merge ${branch}`, `origin/${branch}`);
  gitc(repo, "push", "-q", "origin", "main");
}

test("full ticket lifecycle across both parties", () => {
  const env = setup();
  const { specA, specB, code } = env;

  // B opens from its code repo; human_commit mode prints commands
  ok(code, "open", "--title", "Gate G3 cannot be measured on staging", "--level", "T1", "--reason", "repo fix",
     "--requirement", "human-a, kickoff 2026-10-20", "--spec-ref", "spec/GATE.md#GATE-003 @ v0.1.0");
  fillTicket(join(specB, "conversation/SYNC-001/ticket.md")); ok(code, "index");
  assert.match(ok(code, "inbox", "--all"), /SYNC-001\s+T1\s+open/);
  const sub = ok(code, "submit", "SYNC-001");
  assert.match(sub, /human_commit mode/); assert.match(sub, /collab ship SYNC-001/);   // agent stops, tells the human
  // the human runs one command
  const shipped = ok(code, "ship", "4".replace("4", "1"));
  const branch = /pushed (\S+)/.exec(shipped)[1];
  mergeOnRemote(env, specA, branch);

  // A sees it, raises to T2 (point disputed), replies, submits in agent_push mode
  assert.match(ok(specA, "inbox"), /SYNC-001/);
  ok(specA, "state", "SYNC-001", "discussing", "--level", "T2", "--reason", "changes a gate result");
  ok(specA, "reply", "SYNC-001", "--points", "P1");
  fillTurn(lastTurn(join(specA, "conversation/SYNC-001")));
  const subA = ok(specA, "submit", "SYNC-001");
  assert.match(subA, /pushed conv\/SYNC-001-agent-a/);
  const brA = /pushed (\S+)/.exec(subA)[1];
  mergeOnRemote(env, specA, brA);

  // B replies, both conclude + sign, human-a approves
  gitc(specB, "switch", "-q", "main"); gitc(specB, "pull", "-q", "origin", "main");
  assert.match(ok(code, "inbox"), /SYNC-001\s+T2\s+discussing/);
  ok(code, "reply", "SYNC-001", "--points", "P1");
  fillTurn(lastTurn(join(specB, "conversation/SYNC-001")));
  ok(code, "conclude", "SYNC-001");
  fillConclusion(join(specB, "conversation/SYNC-001/99-conclusion.md"));
  ok(code, "sign", "SYNC-001");
  ok(specB, "sign", "SYNC-001", "--as", "agent-a");
  const t = readFileSync(join(specB, "conversation/SYNC-001/ticket.md"), "utf8");
  assert.match(t, /state: agreed/); assert.match(t, /waiting_for: human-a/);
  // implementer human may not decide a T2
  assert.notEqual(ck(specB, "decide", "SYNC-001", "--decision", "approve", "--as", "human-b").code, 0);
  ok(specB, "decide", "SYNC-001", "--decision", "approve", "--option", "A", "--as", "human-a");
  ok(specB, "state", "SYNC-001", "in-spec", "--ref", "v0.2.0", "--as", "agent-a");
  ok(specB, "state", "SYNC-001", "conformed", "--ref", "v0.2.0", "--as", "agent-b");
  assert.match(ok(specB, "check"), /OK/);

  // 0.4.1: the history is rebuilt from git, as CloudEvents
  gitc(specB, "add", "-A"); gitc(specB, "commit", "-qm", "rest of SYNC-001", "-m", "Agent: agent-b"); gitc(specB, "tag", "v0.2.0");
  const ev = ok(specB, "log").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(ev.every((e) => e.specversion === "1.0" && e.type.startsWith("tech.collabkit.") && e.id && e.time && e.source === "collabkit:demo"));
  const types = ev.map((e) => e.type.replace("tech.collabkit.", ""));
  for (const k of ["ticket.opened", "turn.added", "level.raised", "ticket.concluded", "conclusion.signed", "decision.recorded", "state.changed", "spec.released"])
    assert.ok(types.includes(k), k + " missing: " + types.join(","));
  const opened = ev.find((e) => e.type.endsWith("ticket.opened"));
  assert.equal(opened.data.actor, "agent-b"); assert.equal(opened.subject, "SYNC-001");
  const dec = ev.find((e) => e.type.endsWith("decision.recorded"));
  assert.equal(dec.data.actor, "human-a"); assert.equal(dec.data.option, "A"); assert.match(dec.data.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(ev.filter((e) => e.type.endsWith("turn.added")).map((e) => e.data.actor), ["agent-a", "agent-b"]);
  assert.deepEqual(ev.filter((e) => e.type.endsWith("conclusion.signed")).map((e) => e.data.actor).sort(), ["agent-a", "agent-b"]);
  assert.ok(!types.some((k) => ["state.reverted", "turn.edited", "level.lowered"].includes(k)), types.join());
  assert.match(ok(specB, "log", "--pretty", "--type", "decision.recorded"), /SYNC-001\s+decision.recorded\s+human-a approve=A/);
  // viz: one self-contained file, data embedded, nothing loaded from the network
  const home = join(env.T, "home");
  const vo = okE(specB, { COLLAB_HOME: home }, "viz");
  const html = readFileSync(join(home, "viz", "demo.html"), "utf8");
  assert.match(vo, /events, 1 tickets/);
  assert.ok(!/<script[^>]+src=|<link[^>]+href=/i.test(html));
  const data = JSON.parse(/<script id="collab-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.equal(data.events.length, ev.length); assert.equal(data.parties["spec-owner"].human, "human-a");
});

test("rules: level lowering, edited turns, secrets, mixed PRs, turn limit", () => {
  const env = setup();
  const { specA } = env;
  ok(specA, "open", "--title", "x", "--level", "T2", "--reason", "r", "--requirement", "human-a");
  fillTicket(join(specA, "conversation/SYNC-001/ticket.md")); ok(specA, "index");
  gitc(specA, "add", "-A"); gitc(specA, "commit", "-qm", "open");

  // agent cannot lower via CLI
  assert.notEqual(ck(specA, "state", "SYNC-001", "--level", "T1").code, 0);
  // hand edit lowering is caught by check
  const tf = join(specA, "conversation/SYNC-001/ticket.md");
  writeFileSync(tf, readFileSync(tf, "utf8").replace("level: T2", "level: T1"));
  assert.match(ck(specA, "check").out, /level-lowered/);
  gitc(specA, "checkout", "--", "conversation");

  // turns are append-only
  ok(specA, "reply", "SYNC-001", "--points", "P1", "--as", "agent-b");
  fillTurn(lastTurn(join(specA, "conversation/SYNC-001")));
  gitc(specA, "add", "-A"); gitc(specA, "commit", "-qm", "turn");
  appendFileSync(join(specA, "conversation/SYNC-001/01-agent-b.md"), "\nedit\n");
  assert.match(ck(specA, "check").out, /turn-edited/);
  gitc(specA, "checkout", "--", "conversation");

  // secrets
  appendFileSync(tf, "\nDATABASE_URL=postgres://app:hunter22@db:5432/x\n");
  assert.match(ck(specA, "check").out, /secret/);
  gitc(specA, "checkout", "--", "conversation");

  // mixed PR
  writeFileSync(join(specA, "spec.md"), "spec change\n");
  ok(specA, "reply", "SYNC-001", "--points", "P1");
  assert.match(ck(specA, "check", "--pr", "--base", "HEAD").out, /mixed-pr/);

  // turn limit per point
  ok(specA, "reply", "SYNC-001", "--points", "P1", "--as", "agent-b");
  const r = ck(specA, "reply", "SYNC-001", "--points", "P1", "--as", "agent-b");
  assert.notEqual(r.code, 0); assert.match(r.out, /Escalate/);
});

test("NO_REQUIREMENT parks immediately; weekly cap", () => {
  const { specA } = setup();
  ok(specA, "open", "--title", "nice to have", "--level", "T1", "--reason", "r", "--requirement", "NO_REQUIREMENT");
  assert.match(readFileSync(join(specA, "conversation/SYNC-001/ticket.md"), "utf8"), /state: parked/);
  for (let i = 0; i < 4; i++) ok(specA, "open", "--title", `t${i}`, "--level", "T1", "--reason", "r", "--requirement", "human-a");
  const r = ck(specA, "open", "--title", "one too many", "--level", "T1", "--reason", "r", "--requirement", "human-a");
  assert.notEqual(r.code, 0); assert.match(r.out, /weekly cap/);
  ok(specA, "open", "--title", "prod is wrong", "--level", "T3", "--reason", "live", "--requirement", "human-a");
});

test("init PR may touch files outside conversation/; ticket PR may not", () => {
  const T = mkdtempSync(join(tmpdir(), "collabkit-"));
  const repo = join(T, "spec");
  sh(T, "git", ["init", "-q", "-b", "main", repo]); id(repo, "A");
  writeFileSync(join(repo, "README.md"), "spec\n");
  gitc(repo, "add", "-A"); gitc(repo, "commit", "-qm", "base");
  ok(repo, "init", "--integration", "generic,claude");
  assert.match(ok(repo, "check", "--pr", "--base", "HEAD"), /OK|WARN/);
  gitc(repo, "add", "-A"); gitc(repo, "commit", "-qm", "init");
  ok(repo, "open", "--title", "x", "--level", "T2", "--reason", "r", "--requirement", "human-a");
  writeFileSync(join(repo, "README.md"), "spec changed\n");
  assert.match(ck(repo, "check", "--pr", "--base", "HEAD").out, /mixed-pr/);
});

test("piping into head does not crash", () => {
  const r = spawnSync("sh", ["-c", `node ${CLI} help | head -1`], { encoding: "utf8" });
  assert.equal(r.status, 0); assert.doesNotMatch(r.stderr, /EPIPE/);
});

test("an unfilled turn or ticket fails check", () => {
  const T = mkdtempSync(join(tmpdir(), "collabkit-"));
  const repo = join(T, "spec");
  sh(T, "git", ["init", "-q", "-b", "main", repo]); id(repo, "A");
  ok(repo, "init");
  ok(repo, "open", "--title", "x", "--level", "T2", "--reason", "r", "--requirement", "human-a");
  assert.match(ck(repo, "check").out, /ticket-unfilled/);
  fillTicket(join(repo, "conversation/SYNC-001/ticket.md")); ok(repo, "index");
  ok(repo, "reply", "SYNC-001", "--points", "P1", "--as", "agent-b");
  const r = ck(repo, "check");
  assert.notEqual(r.code, 0); assert.match(r.out, /turn-unfilled/);
  fillTurn(lastTurn(join(repo, "conversation/SYNC-001")));
  assert.match(ok(repo, "check"), /OK/);
});

// ---------------------------------------------------------------- 0.2.0 rules
function soloRepo(cfgPatch) {
  const T = mkdtempSync(join(tmpdir(), "collabkit-"));
  const repo = join(T, "spec");
  sh(T, "git", ["init", "-q", "-b", "main", repo]); id(repo, "A");
  ok(repo, "init");
  if (cfgPatch) { const f = join(repo, "conversation/config.yml"); let t = readFileSync(f, "utf8");
    for (const [k, v] of Object.entries(cfgPatch)) t = t.replace(new RegExp(`^${k}: .*$`, "m"), `${k}: ${v}`);
    writeFileSync(f, t); }
  return repo;
}
function openFilled(repo, level = "T2", as = "agent-b") {
  ok(repo, "open", "--title", "x", "--level", level, "--reason", "r", "--requirement", "human-a", "--as", as);
  const id = readdirSync(join(repo, "conversation")).filter((n) => /^SYNC-/.test(n)).sort().at(-1);
  fillTicket(join(repo, "conversation", id, "ticket.md")); ok(repo, "index");
  return id;
}
function agreeAndSign(repo, id) {
  ok(repo, "reply", id, "--points", "P1", "--as", "agent-a"); agreeTurn(lastTurn(join(repo, "conversation", id)));
  ok(repo, "conclude", id, "--as", "agent-b"); fillConclusion(join(repo, "conversation", id, "99-conclusion.md"));
  ok(repo, "sign", id, "--as", "agent-b"); ok(repo, "sign", id, "--as", "agent-a");
}

test("0.2: a spec change needs the spec owner's human, even for T1", () => {
  const repo = soloRepo();
  const id = openFilled(repo, "T1");
  agreeAndSign(repo, id);
  ok(repo, "decide", id, "--decision", "approve", "--as", "human-b");      // implementer human may approve a T1...
  const r = ck(repo, "state", id, "in-spec", "--ref", "v0.2.0", "--as", "agent-a");
  assert.notEqual(r.code, 0); assert.match(r.out, /decision by human-a/); // ...but not a spec change
  const tf = join(repo, "conversation", id, "ticket.md");                  // hand edit is caught too
  writeFileSync(tf, readFileSync(tf, "utf8").replace("state: approved", "state: in-spec\nspec_change_ref: v0.2.0"));
  ok(repo, "index");
  assert.match(ck(repo, "check").out, /spec-change-decider/);
});

test("0.2: editing a signed conclusion voids the signatures", () => {
  const repo = soloRepo();
  const id = openFilled(repo);
  agreeAndSign(repo, id);
  assert.match(ok(repo, "check"), /OK/);
  appendFileSync(join(repo, "conversation", id, "99-conclusion.md"), "\nOne more thing nobody signed.\n");
  const r = ck(repo, "check");
  assert.notEqual(r.code, 0); assert.match(r.out, /signature-stale/);
  ok(repo, "sign", id, "--as", "agent-a"); ok(repo, "sign", id, "--as", "agent-b");
  assert.match(ok(repo, "check"), /OK/);
});

test("0.2: when the other side agrees on every point, reply is refused", () => {
  const repo = soloRepo();
  const id = openFilled(repo);
  ok(repo, "reply", id, "--points", "P1", "--as", "agent-a"); agreeTurn(lastTurn(join(repo, "conversation", id)));
  assert.match(ok(repo, "check"), /should-conclude/);
  const r = ck(repo, "reply", id, "--points", "P1", "--as", "agent-b");
  assert.notEqual(r.code, 0); assert.match(r.out, /collab conclude/);
});

test("0.2: turn and point caps", () => {
  const repo = soloRepo({ max_turns_per_ticket: 2, max_points_per_ticket: 2 });
  const id = openFilled(repo);
  ok(repo, "reply", id, "--points", "P1,P2", "--as", "agent-a"); fillTurn(lastTurn(join(repo, "conversation", id)));
  let r = ck(repo, "reply", id, "--points", "P3", "--as", "agent-b");
  assert.notEqual(r.code, 0); assert.match(r.out, /separate ticket/);
  ok(repo, "reply", id, "--points", "P1", "--as", "agent-b"); fillTurn(lastTurn(join(repo, "conversation", id)));
  r = ck(repo, "reply", id, "--points", "P1", "--as", "agent-a");
  assert.notEqual(r.code, 0); assert.match(r.out, /collab conclude/);
});

test("0.2: decide several tickets in one command, all-or-nothing", () => {
  const repo = soloRepo();
  const a = openFilled(repo); agreeAndSign(repo, a);
  const b = openFilled(repo); agreeAndSign(repo, b);
  const c = openFilled(repo);                                   // still open: cannot be approved
  const bad = ck(repo, "decide", `${a}=A`, `${c}=X`, "--decision", "approve", "--as", "human-a");
  assert.notEqual(bad.code, 0);
  assert.match(readFileSync(join(repo, "conversation", a, "ticket.md"), "utf8"), /state: agreed/); // nothing written
  const out = ok(repo, "decide", `${a}=A`, `${b}=P1 registry; P2 B1+B2`, "--decision", "approve", "--as", "human-a");
  assert.match(out, /approved \(A\)/); assert.match(out, /approved \(P1 registry; P2 B1\+B2\)/);
  assert.match(readFileSync(join(repo, "conversation", b, "ticket.md"), "utf8"), /option: P1 registry; P2 B1\+B2/);
});

test("0.2: inbox warns when the spec repo is on another branch", () => {
  const repo = soloRepo();
  gitc(repo, "add", "-A"); gitc(repo, "commit", "-qm", "init");
  gitc(repo, "switch", "-q", "-c", "old-branch");
  assert.match(ok(repo, "inbox", "--all"), /WARN .*not "main"/);
});

// ---------------------------------------------------------------- 0.3.0
test("0.3: CI identity check - a turn or decision must be pushed by its party's login", () => {
  const T = mkdtempSync(join(tmpdir(), "collabkit-"));
  const repo = join(T, "spec");
  sh(T, "git", ["init", "-q", "-b", "main", repo]); id(repo, "A");
  ok(repo, "init", "--spec-github", "alice", "--impl-github", "bob");
  gitc(repo, "add", "-A"); gitc(repo, "commit", "-qm", "init");
  const tid = openFilled(repo, "T2", "agent-b");
  let r = ck(repo, "check", "--base", "HEAD", "--actor", "alice");
  assert.notEqual(r.code, 0); assert.match(r.out, /identity-mismatch.*only @bob/);
  assert.match(ok(repo, "check", "--base", "HEAD", "--actor", "bob"), /OK|WARN/);
  gitc(repo, "add", "-A"); gitc(repo, "commit", "-qm", "open");
  agreeAndSign(repo, tid);
  gitc(repo, "add", "-A"); gitc(repo, "commit", "-qm", "agreed");
  ok(repo, "decide", tid, "--decision", "approve", "--as", "human-a");
  r = ck(repo, "check", "--base", "HEAD", "--actor", "bob");
  assert.notEqual(r.code, 0); assert.match(r.out, /decision by human-a was pushed by @bob/);
  assert.match(ok(repo, "check", "--base", "HEAD", "--actor", "alice"), /OK|WARN/);
});

test("0.3: next tells each identity what to do, with commands", () => {
  const repo = soloRepo();
  const tid = openFilled(repo, "T2", "agent-b");
  assert.match(ok(repo, "next", "--as", "agent-a"), new RegExp(`collab reply ${tid}`));
  assert.match(ok(repo, "next", "--as", "agent-b"), /nothing waiting/);
  ok(repo, "reply", tid, "--points", "P1", "--as", "agent-a"); agreeTurn(lastTurn(join(repo, "conversation", tid)));
  assert.match(ok(repo, "next", "--as", "agent-b"), new RegExp(`collab conclude ${tid}`));
  ok(repo, "conclude", tid, "--as", "agent-b"); fillConclusion(join(repo, "conversation", tid, "99-conclusion.md"));
  ok(repo, "sign", tid, "--as", "agent-b");
  assert.match(ok(repo, "next", "--as", "agent-a"), new RegExp(`collab sign ${tid}`));
  ok(repo, "sign", tid, "--as", "agent-a");
  assert.match(ok(repo, "next", "--as", "human-a"), new RegExp(`collab decide ${tid}=<option>`));
});

test("0.3: upgrade repins the workflow, refreshes rules, adds config keys, never touches tickets", () => {
  const repo = soloRepo();
  const tid = openFilled(repo, "T2", "agent-b");
  const wf = join(repo, ".github/workflows/collabkit-check.yml");
  writeFileSync(wf, readFileSync(wf, "utf8").replace(/collabkit-cli@[\d.]+/g, "collabkit-cli@0.1.1"));
  const cf = join(repo, "conversation/config.yml");
  writeFileSync(cf, readFileSync(cf, "utf8").replace(/^max_turns_per_ticket:.*\n/m, "").replace(/^\s+github:.*\n/gm, ""));
  const rd = join(repo, "conversation/README.md");
  writeFileSync(rd, readFileSync(rd, "utf8").replace("collab sync", "git pull"));
  const ticketBefore = readFileSync(join(repo, "conversation", tid, "ticket.md"), "utf8");
  const out = ok(repo, "upgrade", "--spec-github", "alice");
  assert.match(out, /workflow|repinned/); assert.match(out, /config keys/); assert.match(out, /rules block/);
  assert.match(readFileSync(wf, "utf8"), new RegExp(`collabkit-cli@${JSON.parse(readFileSync(join(dirname(CLI), "..", "package.json"), "utf8")).version.replace(/\./g, "\\.")}`));
  assert.match(readFileSync(wf, "utf8"), /COLLAB_ACTOR/);              // full refresh, not just a repin
  const cfg = readFileSync(cf, "utf8");
  assert.match(cfg, /max_turns_per_ticket: 6/); assert.match(cfg, /github: alice/); assert.match(cfg, /# collabkit config/);
  assert.match(readFileSync(rd, "utf8"), /collab sync/);
  assert.equal(readFileSync(join(repo, "conversation", tid, "ticket.md"), "utf8"), ticketBefore);
  assert.match(ok(repo, "upgrade"), /already up to date/);
});

test("0.3: printed git commands quote paths with spaces", () => {
  const T = mkdtempSync(join(tmpdir(), "collabkit-"));
  const spec = join(T, "spec repo"), code = join(T, "code");
  sh(T, "git", ["init", "-q", "-b", "main", spec]); id(spec, "A");
  ok(spec, "init"); gitc(spec, "add", "-A"); gitc(spec, "commit", "-qm", "init");
  sh(T, "git", ["init", "-q", "-b", "main", code]);
  ok(code, "link", "../spec repo");
  ok(code, "open", "--title", "x", "--level", "T2", "--reason", "r", "--requirement", "human-a");
  fillTicket(join(spec, "conversation/SYNC-001/ticket.md")); ok(code, "index");
  const out = ok(code, "submit", "SYNC-001", "--dry-run");
  assert.match(out, /git -C "\.\.\/spec repo" switch -c/);
});

test("0.3: sync and short ids", () => {
  const env = setup();
  const { specA } = env;
  gitc(specA, "switch", "-q", "-c", "old");
  assert.match(ok(specA, "sync"), /switched .* to main/);
  ok(specA, "open", "--title", "x", "--level", "T2", "--reason", "r", "--requirement", "human-a");
  const r = ck(specA, "sync");
  assert.notEqual(r.code, 0); assert.match(r.out, /uncommitted changes/);
  fillTicket(join(specA, "conversation/SYNC-001/ticket.md")); ok(specA, "index");
  assert.match(ok(specA, "reply", "1", "--points", "P1", "--as", "agent-b"), /turn 01/);
  assert.match(ok(specA), /SYNC-001/);                          // bare `collab` = next
});

test("0.3.1: ship refuses non-ticket changes instead of committing half of them", () => {
  const repo = soloRepo();
  gitc(repo, "add", "-A"); gitc(repo, "commit", "-qm", "init");
  writeFileSync(join(repo, "AGENTS.md"), readFileSync(join(repo, "AGENTS.md"), "utf8") + "\nlocal note\n");
  const cf = join(repo, "conversation/config.yml");
  writeFileSync(cf, readFileSync(cf, "utf8").replace("max_turns_per_ticket: 6", "max_turns_per_ticket: 7"));
  let r = ck(repo, "ship");
  assert.notEqual(r.code, 0); assert.match(r.out, /not a ticket change/);
  gitc(repo, "checkout", "--", "AGENTS.md");
  r = ck(repo, "ship");
  assert.notEqual(r.code, 0); assert.match(r.out, /no ticket changed/);
});

// ---------------------------------------------------------------- 0.4 semi-auto
const sigFile = (repo, path, ref = "origin/collab/signals") => {
  gitc(repo, "fetch", "-q", "origin", "+refs/heads/collab/signals:refs/remotes/origin/collab/signals");
  return JSON.parse(gitc(repo, "show", `${ref}:${path}`));
};
const FAKE_AGENT = `
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
execFileSync("collab", ["reply", "SYNC-001", "--points", "P1"], { stdio: "inherit" });
const d = "conversation/SYNC-001";
const f = d + "/" + readdirSync(d).filter((n) => /^\\d\\d-/.test(n) && n !== "99-conclusion.md").sort().at(-1);
writeFileSync(f, readFileSync(f, "utf8").replace(/<name>/g, "scope").replace("- agree | disagree | need data", "- disagree").replace("- reason + evidence", "- evidence: log of 2026-10-27"));
if (process.env.FAKE_EVIL) writeFileSync("README.md", "pwned\\n");
`;

function autoSetup({ autonomy = "semi", level = "T1" } = {}) {
  const env = setup();
  const { T, specA, code, specB } = env;
  const cf = join(specA, "conversation/config.yml");
  writeFileSync(cf, readFileSync(cf, "utf8").replace(/^autonomy: .*$/m, `autonomy: ${autonomy}`));
  gitc(specA, "commit", "-qam", "autonomy", "--allow-empty"); gitc(specA, "push", "-q", "origin", "main");
  gitc(specB, "pull", "-q", "origin", "main");
  ok(code, "open", "--title", "Gate G3 cannot be measured", "--level", level, "--reason", "r",
     "--requirement", "human-a, kickoff", "--spec-ref", "spec/GATE.md#GATE-003 @ v0.1.0");
  fillTicket(join(specB, "conversation/SYNC-001/ticket.md")); ok(code, "index");
  const branch = /pushed (\S+)/.exec(ok(code, "ship", "1"))[1];
  mergeOnRemote(env, specA, branch);
  const H = { COLLAB_HOME: join(T, "home") };
  writeFileSync(join(T, "agent.mjs"), FAKE_AGENT);
  return { ...env, H };
}
const setAgent = (H, cmd) => {
  const p = join(H.COLLAB_HOME, "auto.json");
  const c = JSON.parse(readFileSync(p, "utf8"));
  for (const w of c.workspaces) w.agent = cmd;
  writeFileSync(p, JSON.stringify(c));
};

test("0.4: semi-auto runner replies in its own clone, pushes a conv/auto branch, writes heartbeat + ack", () => {
  const { T, specA, H } = autoSetup();
  const out = okE(specA, H, "auto", "register");
  assert.match(out, /registered demo-agent-a/);
  setAgent(H, ["node", join(T, "agent.mjs")]);
  const before = gitc(specA, "status", "--porcelain");
  const run = okE(specA, H, "auto", "now");
  assert.match(run, /calling agent for SYNC-001/);
  assert.match(run, /pushed conv\/auto-SYNC-001-agent-a-\d+/);
  assert.equal(gitc(specA, "status", "--porcelain"), before);           // the user's folder was not touched
  const br = gitc(specA, "ls-remote", "origin", "refs/heads/conv/auto-*");
  gitc(specA, "fetch", "-q", "origin");
  const files = gitc(specA, "diff", "--name-only", "origin/main", br.split(/\s/)[0]).trim().split("\n");
  assert.ok(files.every((f) => f.startsWith("conversation/")), files.join());
  assert.equal(sigFile(specA, "heartbeat/agent-a.json").id, "agent-a");
  assert.match(gitc(specA, "show", "origin/collab/signals:.github/workflows/collabkit-signals.yml"), /collab notify/); // or GitHub would not run it
  assert.equal(sigFile(specA, "ack/SYNC-001.json")["agent-a"].turns, 0);
  const rev = sigFile(specA, "events/agent-a.json").map((e) => e.type);
  assert.deepEqual(rev, ["tech.collabkit.runner.agent_called", "tech.collabkit.runner.pushed"]);
  assert.match(okE(specA, H, "log", "--pretty", "--type", "runner.pushed"), /SYNC-001\s+runner.pushed\s+agent-a/);
  // inside the 15-minute cycle a scheduled tick does nothing; `now` restarts the cycle
  assert.equal(okE(specA, H, "auto", "run").trim(), "");
  // the branch is not merged yet: the next run must not call the agent a second time
  assert.match(okE(specA, H, "auto", "now"), /waiting for CI to merge conv\/auto-SYNC-001-agent-a/);
});

test("0.4: agent changes outside conversation/ are thrown away", () => {
  const { T, specA, H } = autoSetup();
  okE(specA, H, "auto", "register");
  setAgent(H, ["node", join(T, "agent.mjs")]);
  const run = okE(specA, { ...H, FAKE_EVIL: "1" }, "auto", "now");
  assert.match(run, /discarded agent changes: files outside conversation\/: README.md/);
  assert.equal(gitc(specA, "ls-remote", "origin", "refs/heads/conv/auto-*").trim(), "");
});

test("0.4: autonomy manual never calls the agent; reminders fire once per wait; notify and status", () => {
  const { T, specA, code, H } = autoSetup({ autonomy: "manual", level: "T3" });
  okE(specA, H, "auto", "register");
  okE(code, H, "auto", "register");                                     // agent-b on the same machine, second workspace
  setAgent(H, ["node", "-e", "require('fs').writeFileSync(process.env.COLLAB_HOME + '/called', '1')"]);
  const later = new Date(Date.now() + 3 * 36e5).toISOString();         // T3 reminds after 2h
  const run = okE(specA, { ...H, COLLAB_NOW: later }, "auto", "now");
  assert.match(run, /autonomy is manual, agent not called/);
  assert.ok(!existsSync(join(H.COLLAB_HOME, "called")));
  const rem = sigFile(specA, "remind/SYNC-001.json");
  assert.equal(rem.waiting_for, "agent-a"); assert.equal(rem.reminded.length, 1);
  // both runners wrote their heartbeat to the one branch
  assert.equal(sigFile(specA, "heartbeat/agent-b.json").id, "agent-b");
  const tip1 = gitc(specA, "rev-parse", "origin/collab/signals").trim();
  okE(specA, { ...H, COLLAB_NOW: new Date(Date.now() + 4 * 36e5).toISOString() }, "auto", "now");
  assert.equal(sigFile(specA, "remind/SYNC-001.json").reminded.length, 1); // same wait -> no second reminder
  const n = okE(specA, {}, "notify", "--after", tip1, "--dry-run");
  assert.match(n, /would comment on \[collab\] SYNC-001: .*waiting on \*\*agent-a\*\*/);
  assert.match(okE(specA, H, "notify", "--before", tip1, "--after", "origin/collab/signals", "--dry-run"), /no new reminders/);
  const st = okE(specA, { ...H, COLLAB_NOW: later }, "status");
  assert.match(st, /autonomy: manual/);
  assert.match(st, /agent-a\s+last check/);
  assert.match(st, /SYNC-001\s+T3\s+discussing|SYNC-001\s+T3\s+open/);
  assert.match(st, /reminded/);
});

test("0.4: notify rejects a reminder written under another party's login", () => {
  const { specA, H } = autoSetup({ autonomy: "manual", level: "T3" });
  const cf = join(specA, "conversation/config.yml");
  writeFileSync(cf, readFileSync(cf, "utf8").replace(/(spec-owner:[\s\S]*?github: )\S+/, "$1alice"));
  gitc(specA, "commit", "-qam", "gh"); gitc(specA, "push", "-q", "origin", "main");
  okE(specA, H, "auto", "register");
  okE(specA, { ...H, COLLAB_NOW: new Date(Date.now() + 3 * 36e5).toISOString() }, "auto", "now");
  gitc(specA, "fetch", "-q", "origin", "+refs/heads/collab/signals:refs/remotes/origin/collab/signals");
  const r = ckE(specA, {}, "notify", "--after", "origin/collab/signals", "--actor", "mallory", "--dry-run");
  assert.notEqual(r.code, 0); assert.match(r.out, /only @alice may/);
  assert.match(okE(specA, {}, "notify", "--after", "origin/collab/signals", "--actor", "alice", "--dry-run"), /would comment .*@alice/);
});

test("0.4: config rejects full auto; init ships the automerge + signals workflows; install --print", () => {
  const { specA, H } = autoSetup({ autonomy: "manual" });
  for (const w of ["collabkit-automerge.yml", "collabkit-signals.yml"]) assert.ok(existsSync(join(specA, ".github/workflows", w)), w);
  assert.match(readFileSync(join(specA, ".github/workflows/collabkit-automerge.yml"), "utf8"), /autonomy:\[\[:space:\]\]\*semi/);
  const cf = join(specA, "conversation/config.yml");
  writeFileSync(cf, readFileSync(cf, "utf8").replace(/^autonomy: .*$/m, "autonomy: auto"));
  const r = ck(specA, "inbox");
  assert.notEqual(r.code, 0); assert.match(r.out, /Full auto is not supported/);
  gitc(specA, "checkout", "--", "conversation/config.yml");
  const p = okE(specA, H, "auto", "install", "--print");
  assert.match(p, /auto run|<key>StartInterval<\/key><integer>60<\/integer>/);
});

test("0.4.1: history flags rule bypasses (a turn edited after the fact, a state moved back)", () => {
  const repo = soloRepo();
  gitc(repo, "add", "-A"); gitc(repo, "commit", "-qm", "init");
  const tid = openFilled(repo, "T2", "agent-b");
  gitc(repo, "add", "-A"); gitc(repo, "commit", "-qm", "open", "-m", "Agent: agent-b");
  ok(repo, "reply", tid, "--points", "P1", "--as", "agent-a"); fillTurn(lastTurn(join(repo, "conversation", tid)));
  gitc(repo, "add", "-A"); gitc(repo, "commit", "-qm", "turn", "-m", "Agent: agent-a");
  const f = lastTurn(join(repo, "conversation", tid));
  writeFileSync(f, readFileSync(f, "utf8") + "\nedited later\n");
  const tf = join(repo, "conversation", tid, "ticket.md");
  gitc(repo, "commit", "-qam", "sneaky edit");
  writeFileSync(tf, readFileSync(tf, "utf8").replace(/^state: discussing$/m, "state: open"));
  gitc(repo, "commit", "-qam", "back to open");
  const ev = ok(repo, "log", "--ticket", tid.split("-")[1]).trim().split("\n").map((l) => JSON.parse(l));
  const edited = ev.find((e) => e.type.endsWith("turn.edited"));
  assert.ok(edited, ev.map((e) => e.type).join()); assert.equal(edited.data.author, "agent-a");
  assert.ok(ev.some((e) => e.type.endsWith("state.reverted") && e.data.from === "discussing" && e.data.to === "open"));
});

test("0.4.2: activity log - commands and notes go to the collab/activity branch, without free text", () => {
  const env = setup();
  const { T, specA, specB, code } = env;
  const H = { COLLAB_HOME: join(T, "home") };
  const cf = join(specA, "conversation/config.yml");
  // off by default: nothing recorded, note refuses
  const off = ckE(specA, H, "note", "x");
  assert.notEqual(off.code, 0); assert.match(off.out, /activity log is off/);
  writeFileSync(cf, readFileSync(cf, "utf8").replace(/^activity_log: .*$/m, "activity_log: on"));
  gitc(specA, "commit", "-qam", "activity on"); gitc(specA, "push", "-q", "origin", "main");
  gitc(specB, "pull", "-q", "origin", "main");
  // B: an agent opens a ticket (title is free text: must not be logged), a human runs a failing command, a note
  okE(code, { ...H, CLAUDECODE: "1" }, "open", "--title", "SECRET customer ACME", "--level", "T2", "--reason", "r", "--requirement", "REQ-001");
  const bad = ckE(code, H, "reply", "9");
  assert.notEqual(bad.code, 0);
  assert.match(okE(code, H, "note", "had to tell A about the new tag outside the channel"), /noted and pushed/);
  // A: sync pushes A's pending events
  okE(specA, H, "sync");
  gitc(specA, "fetch", "-q", "origin", "+refs/heads/collab/activity:refs/remotes/origin/collab/activity");
  const files = gitc(specA, "ls-tree", "--name-only", "origin/collab/activity").trim().split("\n").sort();
  assert.deepEqual(files, ["implementer.jsonl", "spec-owner.jsonl"]);
  const impl = gitc(specA, "show", "origin/collab/activity:implementer.jsonl");
  assert.ok(!/SECRET|ACME/.test(impl), "free text leaked: " + impl);
  const ev = impl.trim().split("\n").map((l) => JSON.parse(l));
  const open = ev.find((e) => e.data.command === "open");
  assert.equal(open.data.kind, "agent"); assert.equal(open.data.actor, "agent-b");
  assert.ok(open.data.args.includes("--title") && open.data.args.includes("--level=T2"), open.data.args.join(" "));
  const fail = ev.find((e) => e.data.command === "reply");
  assert.equal(fail.data.exit, 1); assert.match(fail.data.error, /ticket 9 not found/); assert.equal(fail.data.kind, "human");
  assert.ok(ev.some((e) => e.type === "tech.collabkit.activity.note" && /outside the channel/.test(e.data.text)));
  // main is untouched by the activity branch
  assert.equal(gitc(specA, "log", "--format=%s", "-1", "origin/main").trim(), "activity on");
  // read back, pretty, and in viz
  const pretty = okE(specA, H, "activity", "--pretty");
  assert.match(pretty, /agent-b·agent\s+ok\s+open --title --level=T2/);
  assert.match(pretty, /FAIL\s+reply 9\s+-> ticket 9 not found/);
  assert.match(pretty, /NOTE\s+had to tell A/);
  okE(specA, H, "viz");
  const html = readFileSync(join(H.COLLAB_HOME, "viz", "demo.html"), "utf8");
  const data = JSON.parse(/<script id="collab-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.ok(data.activity.length >= 4, String(data.activity.length));
});
