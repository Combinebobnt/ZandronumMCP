// Strip ZDoom console colour escapes (\x1c followed by a letter or [name]).
export function stripColor(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1c(\[[^\]]*\]|.)/g, "");
}

/**
 * Console output made readable as plain text: colour escapes and the
 * separator-bar glyphs (\x1d-\x1f, e.g. the level-start banner) removed, split
 * into lines, trailing whitespace trimmed, blank lines dropped.
 */
export function cleanConsoleLines(lines: string[]): string[] {
  return lines
    .flatMap((raw) => raw.split(/\r?\n/))
    // eslint-disable-next-line no-control-regex
    .map((line) => stripColor(line).replace(/[\x1d-\x1f]/g, "").trimEnd())
    .filter((line) => line.trim() !== "");
}
