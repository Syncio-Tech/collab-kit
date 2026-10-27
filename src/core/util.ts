import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "0.1.2";

export class CliError extends Error {
  constructor(message: string, public exitCode = 1) { super(message); }
}

export function pkgRoot(): string {
  // dist/core/util.js -> package root
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function templatePath(...p: string[]): string {
  return join(pkgRoot(), "templates", ...p);
}

export function readText(p: string): string { return readFileSync(p, "utf8"); }

export function writeText(p: string, s: string): void {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, s, "utf8");
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function fill(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

export function nowIso(): string {
  const d = new Date();
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? "+" : "-";
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}${sign}${pad(tz / 60)}:${pad(tz % 60)}`;
}

export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d; }
  return 0;
}

export function exists(p: string): boolean { return existsSync(p); }
