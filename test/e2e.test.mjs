// End-to-end: spec repo (A, agent_push) + clone for B (human_commit) + B's code repo linked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
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
  const subA = ok(specA, "submit", "SYNC-001");
  assert.match(subA, /pushed conv\/SYNC-001-agent-a/);
  const brA = /pushed (\S+)/.exec(subA)[1];
  mergeOnRemote(env, specA, brA);

  // B replies, both conclude + sign, human-a approves
  gitc(specB, "switch", "-q", "main"); gitc(specB, "pull", "-q", "origin", "main");
  assert.match(ok(code, "inbox"), /SYNC-001\s+T2\s+discussing/);
  ok(code, "reply", "SYNC-001", "--points", "P1");
  ok(code, "conclude", "SYNC-001");
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
