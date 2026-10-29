import YAML from "yaml";
import { join } from "node:path";
import { CliError, VERSION, compareSemver, exists, readText } from "./util.js";

export type Role = "spec-owner" | "implementer";
export type Mode = "agent_push" | "human_commit";

/** owner: the party's deciding human (and agent). specialist: works tickets assigned to it, escalates, approves only the levels `approve` allows. */
export type Seat = "owner" | "specialist";
export interface Member { agent: string; human: string; github?: string; seat: Seat; }
/** agent/human/github are the party's owner; `members` adds more people (each with an agent and a login). */
export interface Party { agent: string; human: string; mode: Mode; github?: string; members: Member[]; approve: Record<string, Seat>; }
export const DEFAULT_APPROVE: Record<string, Seat> = { T0: "specialist", T1: "specialist", T2: "owner", T3: "owner" };

export interface Config {
  schema_version: number;
  min_version: string;
  project: string;
  folder: string;
  id_prefix: string;
  parties: Record<Role, Party>;
  read_scope: "all" | "mirror";
  max_turns_per_point: number;
  max_turns_per_ticket: number;
  max_points_per_ticket: number;
  max_new_tickets_per_week: number;
  forbidden_patterns: string[];
  areas: string[];
  /** manual (default) | semi: runners may call agents for conversation steps. There is no "auto". */
  autonomy: "manual" | "semi";
  activity_log: boolean;
  remind_after_hours: Record<string, number>;
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
    max_turns_per_ticket: raw.max_turns_per_ticket ?? 6,
    max_points_per_ticket: raw.max_points_per_ticket ?? 5,
    max_new_tickets_per_week: raw.max_new_tickets_per_week ?? 5,
    forbidden_patterns: raw.forbidden_patterns ?? [],
    areas: raw.areas ?? [],
    autonomy: raw.autonomy === "semi" ? "semi" : "manual",
    activity_log: raw.activity_log === true || raw.activity_log === "on",
    remind_after_hours: { T0: 72, T1: 72, T2: 24, T3: 2, ...(raw.remind_after_hours ?? {}) },
  };
  if (raw.autonomy !== undefined && !["manual", "semi"].includes(raw.autonomy))
    throw new CliError(`config: autonomy must be manual | semi (got "${raw.autonomy}"). Full auto is not supported.`);
  const seen = new Set<string>();
  for (const r of ["spec-owner", "implementer"] as Role[]) {
    const p = cfg.parties?.[r] as any;
    if (!p?.agent || !p?.human) throw new CliError(`config: parties.${r}.agent and .human are required`);
    if (p.mode !== "agent_push" && p.mode !== "human_commit") throw new CliError(`config: parties.${r}.mode must be agent_push | human_commit`);
    const extra: Member[] = (Array.isArray(p.members) ? p.members : []).map((m: any, i: number) => {
      if (!m?.agent || !m?.human) throw new CliError(`config: parties.${r}.members[${i}] needs agent and human`);
      const seat = m.seat ?? "specialist";
      if (seat !== "specialist" && seat !== "owner") throw new CliError(`config: parties.${r}.members[${i}].seat must be specialist | owner`);
      return { agent: String(m.agent), human: String(m.human), github: m.github ? String(m.github) : undefined, seat };
    });
    p.members = [{ agent: p.agent, human: p.human, github: p.github, seat: "owner" as Seat }, ...extra];
    p.approve = { ...DEFAULT_APPROVE, ...(p.approve ?? {}) };
    for (const [lv, s] of Object.entries(p.approve)) if (s !== "owner" && s !== "specialist") throw new CliError(`config: parties.${r}.approve.${lv} must be owner | specialist`);
    for (const m of p.members as Member[]) for (const id of [m.agent, m.human]) {
      if (seen.has(id)) throw new CliError(`config: id "${id}" is used twice`);
      seen.add(id);
    }
  }
  if (compareSemver(VERSION, cfg.min_version) < 0)
    throw new CliError(`This repo requires collabkit >= ${cfg.min_version}; you have ${VERSION}. Upgrade: npm i -g collabkit-cli@latest`);
  return cfg;
}

export interface Identity { id: string; kind: "agent" | "human"; role: Role; seat: Seat; member: Member; }

export function findMember(cfg: Config, id: string): { role: Role; member: Member; kind: "agent" | "human" } | undefined {
  for (const role of ["spec-owner", "implementer"] as Role[])
    for (const member of cfg.parties[role].members) {
      if (member.agent === id) return { role, member, kind: "agent" };
      if (member.human === id) return { role, member, kind: "human" };
    }
  return undefined;
}

export function identify(cfg: Config, id: string): Identity {
  const f = findMember(cfg, id);
  if (f) return { id, kind: f.kind, role: f.role, seat: f.member.seat, member: f.member };
  const known = allIds(cfg).join(", ");
  throw new CliError(`Unknown identity "${id}". Known: ${known}`);
}

export function allIds(cfg: Config): string[] {
  return Object.values(cfg.parties).flatMap((p) => p.members.flatMap((m) => [m.agent, m.human]));
}

/** GitHub login that may push on behalf of an id (that member's login). */
export function githubOf(cfg: Config, id: string): string | undefined {
  const g = findMember(cfg, id)?.member.github;
  return g && !/^(CHANGE-ME|OWNER)?$/i.test(String(g)) ? String(g) : undefined;
}

/** The agent of `role` that a ticket is waiting on: on the spec side the assignee (default: the owner's agent). */
export function sideAgent(cfg: Config, role: Role, d?: Record<string, any>): string {
  const p = cfg.parties[role];
  if (d?.assignee && p.members.some((m) => m.agent === d.assignee)) return d.assignee;
  return p.agent;
}

export function counterpartAgent(cfg: Config, role: Role, d?: Record<string, any>): string {
  return sideAgent(cfg, role === "spec-owner" ? "implementer" : "spec-owner", d);
}

export function sideOf(cfg: Config, id: string): Role | undefined { return findMember(cfg, id)?.role; }

/** May this human decide a ticket of this level? Spec side: by the approve table (owner always). Implementer: T0/T1. */
export function canDecide(cfg: Config, id: string, level: string): boolean {
  const f = findMember(cfg, id);
  if (!f || f.kind !== "human") return false;
  const lv = ["T0", "T1", "T2", "T3"].indexOf(level);
  if (f.role === "implementer") return lv < 2;
  return f.member.seat === "owner" || cfg.parties["spec-owner"].approve[level] === "specialist";
}

/** May this human's decision change the spec? Only spec-side humans allowed for the level. */
export function canChangeSpec(cfg: Config, id: string, level: string): boolean {
  return sideOf(cfg, id) === "spec-owner" && canDecide(cfg, id, level);
}

/** The spec-side human who may approve a spec change for this ticket: the assignee's human when the level allows it, else the owner. */
export function specApproverOf(cfg: Config, level: string, d: Record<string, any>): string {
  const spec = cfg.parties["spec-owner"];
  const a = spec.members.find((m) => m.agent === d.assignee);
  return a && (a.seat === "owner" || spec.approve[level] === "specialist") ? a.human : spec.human;
}

/** Who a ticket waits on once both agents signed. */
export function approverOf(cfg: Config, level: string, d: Record<string, any>): string {
  const spec = cfg.parties["spec-owner"];
  if (["T0", "T1"].includes(level)) return cfg.parties.implementer.human;
  if (spec.approve[level] === "owner") return spec.human;
  const a = spec.members.find((m) => m.agent === d.assignee);
  return a ? a.human : spec.human;
}
