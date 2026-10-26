import { execFileSync } from "node:child_process";

export function git(cwd: string, args: string[], allowFail = false): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e: any) {
    if (allowFail) return "";
    throw new Error(`git ${args.join(" ")} failed: ${e.stderr ?? e.message}`);
  }
}

export function isRepo(cwd: string): boolean {
  return git(cwd, ["rev-parse", "--is-inside-work-tree"], true) === "true";
}

export function hasRef(cwd: string, ref: string): boolean {
  return git(cwd, ["rev-parse", "--verify", "--quiet", ref + "^{commit}"], true) !== "";
}

/** File content at ref, or undefined when the file does not exist there. */
export function showAt(cwd: string, ref: string, path: string): string | undefined {
  try {
    return execFileSync("git", ["show", `${ref}:${path}`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch { return undefined; }
}

/** Paths changed between ref and the working tree (committed + staged + unstaged + untracked). */
export function changedSince(cwd: string, ref: string): { path: string; status: string }[] {
  const out: { path: string; status: string }[] = [];
  const diff = git(cwd, ["diff", "--name-status", "--no-renames", ref], true);
  for (const line of diff.split("\n").filter(Boolean)) {
    const [status, path] = line.split("\t");
    out.push({ status, path });
  }
  const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard"], true);
  for (const p of untracked.split("\n").filter(Boolean)) out.push({ status: "A", path: p });
  return out;
}

export function hasCommand(cmd: string): boolean {
  try { execFileSync(cmd, ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}
