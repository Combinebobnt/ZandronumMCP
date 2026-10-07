import { matchLines } from "./lines.js";

/** The `MCP_RUNACS` reply line of `mcp_runacs` (overlay mcp_runacs.inc). */
export interface RunAcsReply {
  module: number;
  scripts: number;
  /** The started script as given (number or name), or "none". */
  started: string;
  /** The snippet holds DEATH/ENTER/RESPAWN/... scripts that fire on later events. */
  deferred: boolean;
}

export function parseRunAcs(lines: string[]): RunAcsReply | undefined {
  return matchLines(
    lines,
    /^MCP_RUNACS module=(\d+) scripts=(\d+) started=(\S+) deferred=([01])$/,
    (m) => ({ module: Number(m[1]), scripts: Number(m[2]), started: m[3], deferred: m[4] === "1" }),
  )[0];
}
