import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse, Doc } from "./frontmatter.js";
import { Config } from "./config.js";
import { exists, readText } from "./util.js";

export const LEVELS = ["T0", "T1", "T2", "T3"] as const;
export type Level = typeof LEVELS[number];
export const STATES = ["open", "discussing", "agreed", "approved", "in-spec", "conformed", "parked", "rejected"] as const;
export type State = typeof STATES[number];
export const NO_REQUIREMENT = "NO_REQUIREMENT";
export const CONCLUSION = "99-conclusion.md";
export const TURN_RE = /^(\d{2})-([a-z0-9][a-z0-9_-]*)\.md$/;

export interface Turn { n: number; by: string; file: string; doc: Doc; }
export interface Ticket {
  id: string; dir: string; file: string; doc: Doc;
  turns: Turn[]; conclusion?: Doc; conclusionFile: string;
}

export function convDir(root: string, cfg: Config): string { return join(root, cfg.folder); }

export function idRe(cfg: Config): RegExp { return new RegExp(`^${cfg.id_prefix}-(\\d{3,})$`); }

export function listTickets(root: string, cfg: Config): Ticket[] {
  const dir = convDir(root, cfg);
  if (!exists(dir)) return [];
  const re = idRe(cfg);
  return readdirSync(dir)
    .filter((n) => re.test(n) && statSync(join(dir, n)).isDirectory())
    .sort()
    .map((n) => loadTicket(root, cfg, n))
    .filter((t): t is Ticket => !!t);
}

export function loadTicket(root: string, cfg: Config, id: string): Ticket | undefined {
  const dir = join(convDir(root, cfg), id);
  const file = join(dir, "ticket.md");
  if (!exists(file)) return undefined;
  const turns: Turn[] = [];
  for (const n of readdirSync(dir).sort()) {
    const m = TURN_RE.exec(n);
    if (!m || n === CONCLUSION) continue;
    turns.push({ n: Number(m[1]), by: m[2], file: join(dir, n), doc: parse(readText(join(dir, n))) });
  }
  const cf = join(dir, CONCLUSION);
  return {
    id, dir, file, doc: parse(readText(file)), turns,
    conclusion: exists(cf) ? parse(readText(cf)) : undefined, conclusionFile: cf,
  };
}

export function nextId(root: string, cfg: Config): string {
  const re = idRe(cfg);
  const dir = convDir(root, cfg);
  let max = 0;
  if (exists(dir)) for (const n of readdirSync(dir)) { const m = re.exec(n); if (m) max = Math.max(max, Number(m[1])); }
  return `${cfg.id_prefix}-${String(max + 1).padStart(3, "0")}`;
}

export function rel(root: string, p: string): string { return relative(root, p).split("\\").join("/"); }

/** Stance per point in a turn: the first "- agree | disagree | need data" bullet under each "### Pn" heading. */
export function stances(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const parts = body.split(/^### +(P\d+)\b.*$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const m = /^\s*-\s*\**\s*(agree|disagree|need data)\b(?!\s*\|)/im.exec(parts[i + 1] ?? ""); // skip the template line "agree | disagree | need data"
    if (m) out[parts[i]] = m[1].toLowerCase();
  }
  return out;
}

/** Signatures are bound to the conclusion text: {at, sha256}. A bare timestamp is a pre-0.2 signature. */
export function conclusionHash(body: string): string {
  return createHash("sha256").update(body.replace(/\r\n/g, "\n").trim()).digest("hex");
}
export interface Sig { at: string; sha256?: string; legacy: boolean; }
export function readSig(v: any): Sig | undefined {
  if (!v) return undefined;
  if (typeof v === "string") return { at: v, legacy: true };
  return { at: String(v.at ?? ""), sha256: v.sha256, legacy: false };
}

export function levelIdx(l: string): number { return LEVELS.indexOf(l as Level); }
