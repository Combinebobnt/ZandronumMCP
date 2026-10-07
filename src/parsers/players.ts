import { parseKvLines, type KvRecord } from "./lines.js";

/**
 * Parse `dumpplayers` output: one record per in-game player, keyed as the
 * engine printed it (`slot`, `bot`, `hp`, `frags`, ..., `name`). A field the
 * engine lacks is simply absent, so callers must not assume a fixed shape.
 */
export function parsePlayers(lines: string[]): KvRecord[] {
  return parseKvLines(lines, "player");
}
