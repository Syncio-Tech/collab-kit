// collab log (CloudEvents JSONL) and collab viz (one self-contained HTML file).
import { spawnSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { Ctx } from "./core/context.js";
import { buildEvents, CollabEvent } from "./core/events.js";
import { fetchSignals } from "./core/signals.js";
import { listTickets } from "./core/ticket.js";
import { pushActivity, readActivity, record } from "./core/activity.js";
import { CliError, VERSION, readText, templatePath, writeText } from "./core/util.js";

type Flags = Record<string, string | boolean>;
const str = (f: Flags, k: string) => (typeof f[k] === "string" ? (f[k] as string) : undefined);

function events(ctx: Ctx, f: Flags): CollabEvent[] {
  fetchSignals(ctx.specRoot);
  let ev = buildEvents(ctx.specRoot, ctx.cfg, { ref: str(f, "ref"), signals: f["no-signals"] !== true });
  const t = str(f, "ticket");
  if (t) { const id = /^\d+$/.test(t) ? `${ctx.cfg.id_prefix}-${t.padStart(3, "0")}` : t.toUpperCase(); ev = ev.filter((e) => e.subject === id); }
  const since = str(f, "since");
  if (since) { const s = Date.parse(since); if (!isFinite(s)) throw new CliError("--since must be a date"); ev = ev.filter((e) => Date.parse(e.time) >= s); }
  const type = str(f, "type");
  if (type) ev = ev.filter((e) => e.type.endsWith(type));
  return ev;
}

export function cmdLog(ctx: Ctx, f: Flags) {
  const ev = events(ctx, f);
  const lines = ev.map((e) => JSON.stringify(e)).join("\n") + (ev.length ? "\n" : "");
  const out = str(f, "out");
  if (out) { writeText(resolve(out), lines); process.stdout.write(`wrote ${ev.length} events to ${out}\n`); return; }
  if (f.pretty === true) {
    const p2 = (n: number) => String(n).padStart(2, "0");
    const local = (s: string) => { const d = new Date(s); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
    for (const e of ev) process.stdout.write(`${local(e.time)}  ${(e.subject ?? "").padEnd(9)} ${e.type.replace("tech.collabkit.", "").padEnd(19)} ${e.data.actor}${e.data.to ? " -> " + e.data.to : ""}${e.data.decision ? " " + e.data.decision + (e.data.option ? "=" + e.data.option : "") : ""}\n`);
    return;
  }
  process.stdout.write(lines);
}

export function cmdViz(ctx: Ctx, f: Flags) {
  const ev = events(ctx, { ...f, ticket: false, type: false } as Flags);
  const tickets = listTickets(ctx.specRoot, ctx.cfg).map((t) => ({ id: t.id, title: t.doc.data.title, level: t.doc.data.level, state: t.doc.data.state, waiting_for: t.doc.data.waiting_for }));
  const activity = ctx.cfg.activity_log || f.activity === true ? readActivity(ctx.specRoot, ctx.cfg) : [];
  const data = { activity, project: ctx.cfg.project, collabkit: VERSION, generated: process.env.COLLAB_NOW ?? new Date().toISOString(), parties: ctx.cfg.parties, tickets, events: ev };
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const html = readText(templatePath("viz", "history.html")).replace("/*__COLLAB_DATA__*/", () => json);
  const out = resolve(str(f, "out") ?? join(process.env.COLLAB_HOME ?? join(homedir(), ".collabkit"), "viz", `${ctx.cfg.project}.html`));
  writeText(out, html);
  process.stdout.write(`wrote ${out} (${ev.length} events, ${tickets.length} tickets)\n`);
  if (f.open === true) {
    const cmd = platform() === "darwin" ? "open" : platform() === "win32" ? "explorer" : "xdg-open";
    spawnSync(cmd, [out], { stdio: "ignore" });
  }
}

export function cmdNote(ctx: Ctx, pos: string[]) {
  const text = pos.join(" ").trim();
  if (!text) throw new CliError('usage: collab note "what got in the way, and where"');
  if (!ctx.cfg.activity_log) throw new CliError("the activity log is off: the spec owner sets `activity_log: on` in conversation/config.yml");
  record(ctx.cfg, { type: "note", text, by: ctx.me?.id, role: ctx.me?.role });
  let pushed = 0;
  try { pushed = pushActivity(ctx.specRoot, ctx.cfg); } catch (e: any) { process.stdout.write(`noted locally; push failed (${e.message ?? e}), will retry on the next sync / ship\n`); return; }
  process.stdout.write(`noted${pushed ? ` and pushed (${pushed} event(s)) to collab/activity` : ""}\n`);
}

export function cmdActivity(ctx: Ctx, pos: string[], f: Flags) {
  if (pos[0] === "push") { const n = pushActivity(ctx.specRoot, ctx.cfg); process.stdout.write(n ? `pushed ${n} event(s) to collab/activity\n` : "nothing to push\n"); return; }
  let ev = readActivity(ctx.specRoot, ctx.cfg);
  const since = str(f, "since");
  if (since) { const s = Date.parse(since); if (isFinite(s)) ev = ev.filter((e) => Date.parse(e.time) >= s); }
  if (f.pretty !== true) { process.stdout.write(ev.map((e) => JSON.stringify(e)).join("\n") + (ev.length ? "\n" : "")); return; }
  if (!ev.length) { process.stdout.write(ctx.cfg.activity_log ? "no activity yet\n" : "the activity log is off (activity_log: on in conversation/config.yml)\n"); return; }
  const p2 = (n: number) => String(n).padStart(2, "0");
  const local = (s: string) => { const d = new Date(s); return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
  for (const e of ev) {
    const d = e.data as any;
    const who = `${d.actor}${d.kind === "agent" ? "·agent" : ""}`.padEnd(16);
    if (e.type.endsWith(".note")) process.stdout.write(`${local(e.time)}  ${who} NOTE  ${d.text}\n`);
    else process.stdout.write(`${local(e.time)}  ${who} ${d.exit ? "FAIL" : "ok  "}  ${[d.command, ...(d.args ?? [])].join(" ")}${d.error ? "  -> " + d.error : ""}\n`);
  }
  const cmds = ev.filter((e) => e.type.endsWith(".command"));
  const fails = cmds.filter((e) => (e.data as any).exit);
  process.stdout.write(`\n${cmds.length} commands, ${fails.length} failed, ${ev.length - cmds.length} notes\n`);
}
