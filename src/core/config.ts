import YAML from "yaml";
import { join } from "node:path";
import { CliError, VERSION, compareSemver, exists, readText } from "./util.js";

export type Role = "spec-owner" | "implementer";
export type Mode = "agent_push" | "human_commit";

export interface Party { agent: string; human: string; mode: Mode; }

export interface Config {
  schema_version: number;
  min_version: string;
  project: string;
  folder: string;
  id_prefix: string;
  parties: Record<Role, Party>;
  read_scope: "all" | "mirror";
  max_turns_per_point: number;
  max_new_tickets_per_week: number;
  forbidden_patterns: string[];
  areas: string[];
}

export const CONFIG_REL = "conversation/config.yml";

export function loadConfig(specRoot: string): Config {
  const p = join(specRoot, CONFIG_REL);
  if (!exists(p)) throw new CliError(`No ${CONFIG_REL} in ${specRoot}. Run \`collab init\` there first.`);
  const raw = YAML.parse(readText(p)) ?? {};
  const cfg: Config = {
    schema_version: raw.schema_version ?? 1,
    min_version: String(raw.min_version ?? "0.1.0"),
    project: raw.project ?? "project",
    folder: "conversation",
    id_prefix: raw.id_prefix ?? "SYNC",
    parties: raw.parties,
    read_scope: raw.read_scope ?? "all",
    max_turns_per_point: raw.max_turns_per_point ?? 2,
    max_new_tickets_per_week: raw.max_new_tickets_per_week ?? 5,
    forbidden_patterns: raw.forbidden_patterns ?? [],
    areas: raw.areas ?? [],
  };
  for (const r of ["spec-owner", "implementer"] as Role[]) {
    const p = cfg.parties?.[r];
    if (!p?.agent || !p?.human) throw new CliError(`config: parties.${r}.agent and .human are required`);
    if (p.mode !== "agent_push" && p.mode !== "human_commit") throw new CliError(`config: parties.${r}.mode must be agent_push | human_commit`);
  }
  if (compareSemver(VERSION, cfg.min_version) < 0)
    throw new CliError(`This repo requires collabkit >= ${cfg.min_version}; you have ${VERSION}. Upgrade: npm i -g collabkit-cli@latest`);
  return cfg;
}

export interface Identity { id: string; kind: "agent" | "human"; role: Role; }

export function identify(cfg: Config, id: string): Identity {
  for (const role of ["spec-owner", "implementer"] as Role[]) {
    const p = cfg.parties[role];
    if (p.agent === id) return { id, kind: "agent", role };
    if (p.human === id) return { id, kind: "human", role };
  }
  const known = allIds(cfg).join(", ");
  throw new CliError(`Unknown identity "${id}". Known: ${known}`);
}

export function allIds(cfg: Config): string[] {
  return Object.values(cfg.parties).flatMap((p) => [p.agent, p.human]);
}

export function counterpartAgent(cfg: Config, role: Role): string {
  return cfg.parties[role === "spec-owner" ? "implementer" : "spec-owner"].agent;
}
