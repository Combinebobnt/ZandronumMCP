/**
 * Parse and summarise the one-line `mcp_status` snapshot the bridge rides on a
 * command's correlator sentinel (see `correlation/sentinel.ts`). Pure — no
 * `BridgeClient` reference — so it's testable without a socket.
 */

export type EngineStatus = Record<string, string>;

/**
 * Parse a console line that carries the correlator sentinel. Returns the
 * `key=value` fields when the line is the `mcp_status` form (sentinel followed
 * by fields), or `undefined` for the legacy bare-`echo` form (just the
 * sentinel, nothing else) — the caller uses `undefined` to mean "no status
 * available", not "engine state unknown".
 */
export function parseStatus(line: string, sentinel: string): EngineStatus | undefined {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0] !== sentinel || tokens.length < 2) return undefined;
  const fields: EngineStatus = {};
  for (const tok of tokens.slice(1)) {
    const eq = tok.indexOf("=");
    if (eq <= 0) continue;
    fields[tok.slice(0, eq)] = tok.slice(eq + 1);
  }
  return fields;
}

interface StatusRow {
  key: string;
  /** The value this field takes when nothing unusual is going on. */
  normal: string;
  note: (value: string, status: EngineStatus) => string;
}

/**
 * One row per condition worth surfacing. `health`/`armor` are deliberately NOT
 * rows here — they're always-present data for `player_state`, not "unusual"
 * conditions — so they never appear in the note. Adding a future condition is
 * one row, not a new branch.
 */
const ROWS: StatusRow[] = [
  { key: "paused", normal: "0", note: () => "paused" },
  {
    key: "menu",
    normal: "off",
    note: (_v, status) =>
      status.menuclass ? `a menu is open (${status.menuclass})` : "a menu is open",
  },
  { key: "console", normal: "up", note: (v) => `console is ${v}` },
  { key: "gamestate", normal: "level", note: (v) => `not in a level (${v})` },
  {
    key: "player",
    normal: "alive",
    note: (v) => (v === "none" ? "no player" : `player is ${v}`),
  },
  { key: "spectating", normal: "0", note: () => "spectating" },
  { key: "demo", normal: "0", note: () => "playing back a demo" },
  { key: "automap", normal: "0", note: () => "automap is open" },
  { key: "chat", normal: "0", note: () => "chat input is open" },
  { key: "demorec", normal: "0", note: () => "recording a demo" },
  { key: "pending", normal: "0", note: () => "a map/save/demo load is pending" },
];

/**
 * Summarise a status snapshot as a short human-readable note, or `undefined`
 * when nothing about it is unusual (the common case, so a normal round trip
 * costs nothing to read).
 */
export function describeStatus(status: EngineStatus): string | undefined {
  const phrases = ROWS.flatMap((row) => {
    const value = status[row.key];
    if (value === undefined || value === row.normal) return [];
    return [row.note(value, status)];
  });
  return phrases.length ? `Engine state: ${phrases.join(", ")}.` : undefined;
}
