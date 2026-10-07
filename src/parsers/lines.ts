/**
 * Shared line-matching for CCMD output parsers, so a new parser is a regex and
 * a mapper rather than another copy of the split-trim-match loop.
 */

/** Map every console line (split on newlines, trimmed) that matches `re`. */
export function matchLines<T>(lines: string[], re: RegExp, map: (m: RegExpMatchArray) => T): T[] {
  const out: T[] = [];
  for (const raw of lines) {
    for (const line of raw.split(/\r?\n/)) {
      const m = line.trim().match(re);
      if (m) out.push(map(m));
    }
  }
  return out;
}

export type KvRecord = Record<string, string | number>;

const NUMERIC = /^-?\d+(?:\.\d+)?$/;

/**
 * Parse a `key=value key=value ... name=<rest of line>` body. `name=` is always
 * last and takes the rest of the line (names can hold spaces) and stays a
 * string; every other numeric-looking value becomes a number.
 */
export function parseKv(body: string): KvRecord {
  const out: KvRecord = {};
  const nameAt = body.startsWith("name=") ? 0 : body.indexOf(" name=");
  const head = nameAt < 0 ? body : body.slice(0, nameAt);
  for (const tok of head.split(/\s+/)) {
    const eq = tok.indexOf("=");
    if (eq <= 0) continue;
    const value = tok.slice(eq + 1);
    out[tok.slice(0, eq)] = NUMERIC.test(value) ? Number(value) : value;
  }
  if (nameAt >= 0) out.name = body.slice(body.indexOf("name=", nameAt) + 5);
  return out;
}

/** Every `<tag> key=value ...` line, parsed with `parseKv`. */
export function parseKvLines(lines: string[], tag: string): KvRecord[] {
  return matchLines(lines, new RegExp(`^${tag} (.*)$`), (m) => parseKv(m[1]));
}

/** The message of the first `error <message>` line a CCMD printed, if any. */
export function firstError(lines: string[]): string | undefined {
  return matchLines(lines, /^error (.+)$/, (m) => m[1])[0];
}

/** Whether a CCMD printed its header line (e.g. `MCP_FOUND`); absent means it never ran. */
export function hasHeader(lines: string[], header: string): boolean {
  return matchLines(lines, new RegExp(`^${header}$`), () => true).length > 0;
}

/** Why a CCMD gave no usable reply: its `error` line, else whatever it printed. */
export function failureText(lines: string[]): string {
  return firstError(lines) ?? (lines.join("\n").trim() || "(no output)");
}
