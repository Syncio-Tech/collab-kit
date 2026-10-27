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
  assert.match(sub, /human_commit mode/);
  // the human runs the printed commands
  const branch = /switch -c (\S+)/.exec(sub)[1];
  gitc(specB, "switch", "-q", "-c", branch); gitc(specB, "add", "conversation");
  gitc(specB, "commit", "-qm", "collab(SYNC-001): open", "-m", "Agent: agent-b"); gitc(specB, "push", "-q", "-u", "origin", branch);
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
