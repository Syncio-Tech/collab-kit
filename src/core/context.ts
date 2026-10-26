import YAML from "yaml";
import { dirname, join, resolve } from "node:path";
import { CliError, exists, readText } from "./util.js";
import { CONFIG_REL, Config, Identity, identify, loadConfig } from "./config.js";

export interface Ctx {
  specRoot: string;       // repo that holds conversation/
  workRoot: string;       // repo the agent works in (== specRoot on the spec-owner side)
  cfg: Config;
  me?: Identity;
}

function walkUp(start: string, rel: string): string | undefined {
  let d = resolve(start);
  for (;;) {
    if (exists(join(d, rel))) return d;
    const up = dirname(d);
    if (up === d) return undefined;
    d = up;
  }
}

export function loadCtx(cwd: string, asFlag?: string, requireMe = true): Ctx {
  let specRoot = walkUp(cwd, CONFIG_REL);
  let workRoot = specRoot;
  let asId = asFlag ?? process.env.COLLABKIT_AS;
  if (!specRoot) {
    const linkDir = walkUp(cwd, ".collabkit/link.yml");
    if (!linkDir) throw new CliError("Not inside a collabkit spec repo or a linked repo. Run `collabkit init` (spec repo) or `collabkit link <spec-repo>` (code repo).");
    const link = YAML.parse(readText(join(linkDir, ".collabkit/link.yml"))) ?? {};
    specRoot = resolve(linkDir, link.spec_repo ?? "");
    workRoot = linkDir;
    if (!exists(join(specRoot, CONFIG_REL))) throw new CliError(`Linked spec repo not found at ${specRoot} (.collabkit/link.yml). Clone it there or re-run \`collabkit link\`.`);
    asId = asId ?? link.as;
  }
  if (!asId) {
    const local = join(workRoot!, ".collabkit/local.yml");
    if (exists(local)) asId = (YAML.parse(readText(local)) ?? {}).as;
  }
  const cfg = loadConfig(specRoot);
  const ctx: Ctx = { specRoot, workRoot: workRoot!, cfg };
  if (asId) ctx.me = identify(cfg, asId);
  else if (requireMe) throw new CliError("Who are you? Pass --as <id>, set COLLABKIT_AS, or write `as: <id>` in .collabkit/local.yml.");
  return ctx;
}
