import { describe, it, expect } from "vitest";
import { cleanConsoleLines, stripColor } from "../src/parsers/consoletext.js";

describe("stripColor", () => {
  it("drops letter and named colour escapes", () => {
    expect(stripColor("\x1cGred \x1c[Gold]gold \x1c-plain")).toBe("red gold plain");
  });
});

describe("cleanConsoleLines", () => {
  it("splits, strips bars and colours, and drops blank lines", () => {
    const bar = "\x1d" + "\x1e".repeat(5) + "\x1f";
    expect(cleanConsoleLines([`\n${bar}\n\n\x1c+MAP01 - entryway  \r\n`, "next\n"])).toEqual([
      "MAP01 - entryway",
      "next",
    ]);
  });

  it("returns nothing for empty output", () => {
    expect(cleanConsoleLines([])).toEqual([]);
    expect(cleanConsoleLines(["\n", " "])).toEqual([]);
  });
});
