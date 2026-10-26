import { join, relative } from "node:path";
import { Config, Role } from "./config.js";
import { VERSION, exists, fill, readText, templatePath, writeText } from "./util.js";

export const INTEGRATIONS = ["generic", "claude"] as const;
export type Integration = typeof INTEGRATIONS[number];

const START = "<!-- collabkit:start -->";
const END = "<!-- collabkit:end -->";

export function upsertBlock(file: string, block: string, header = ""): void {
  const wrapped = `${START}\n${block.trim()}\n${END}`;
  if (!exists(file)) { writeText(file, (header ? header + "\n\n" : "") + wrapped + "\n"); return; }
  const cur = readText(file);
  const re = new RegExp(`${START}[\\s\\S]*?${END}`);
  writeText(file, re.test(cur) ? cur.replace(re, wrapped) : cur.trimEnd() + "\n\n" + wrapped + "\n");
}

export interface IntegrationVars { workRoot: string; specRoot: string; cfg: Config; me: string; role: Role; }

export function installIntegrations(list: string[], v: IntegrationVars): string[] {
  const written: string[] = [];
  const specRel = relative(v.workRoot, v.specRoot).split("\\").join("/") || ".";
  const conv = specRel === "." ? v.cfg.folder : `${specRel}/${v.cfg.folder}`;
  const party = v.cfg.parties[v.role];
  const vars: Record<string, string> = {
    version: VERSION, me: v.me, role: v.role, mode: party.mode, conv, spec_repo: specRel,
    max_turns: String(v.cfg.max_turns_per_point),
    where: specRel === "." ? "This repo holds the spec and the conversation channel in `conversation/`."
      : `This repo is linked to the spec repo at \`${specRel}\`; the channel is \`${conv}/\` (run \`git -C ${specRel} pull\` first).`,
    inbox_hint: specRel === "." ? "" : " (from this repo; it follows `.collabkit/link.yml`)",
  };
  const block = fill(readText(templatePath("integrations", "rules-block.md")), vars);
  for (const name of list) {
    if (name === "generic") {
      const f = join(v.workRoot, "AGENTS.md");
      upsertBlock(f, block, "# AGENTS.md"); written.push(f);
    } else if (name === "claude") {
      const f = join(v.workRoot, "CLAUDE.md");
      upsertBlock(f, block, "# CLAUDE.md"); written.push(f);
      const s = join(v.workRoot, ".claude", "skills", "collabkit", "SKILL.md");
      writeText(s, fill(readText(templatePath("integrations", "claude", "SKILL.md")), vars)); written.push(s);
    } else {
      throw new Error(`unknown integration "${name}" (available: ${INTEGRATIONS.join(", ")})`);
    }
  }
  return written;
}
