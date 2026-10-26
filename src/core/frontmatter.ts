import YAML from "yaml";

export interface Doc { data: Record<string, any>; body: string; }

const RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parse(text: string): Doc {
  const m = RE.exec(text);
  if (!m) return { data: {}, body: text };
  const data = YAML.parse(m[1]) ?? {};
  return { data: typeof data === "object" ? data : {}, body: m[2] };
}

export function stringify(doc: Doc): string {
  const y = YAML.stringify(doc.data, { lineWidth: 0 }).trimEnd();
  return `---\n${y}\n---\n${doc.body.startsWith("\n") ? doc.body : "\n" + doc.body}`;
}
