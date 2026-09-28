import { describe, it, expect } from "vitest";
import { parseStartupErrors, tailLines, crashLogPath, readLogWindow, crashReportPid } from "../src/process/startuplog.js";

const SAMPLE = [
  "Resolving GL extensions",
  "adding doom2.wad, 2919 lumps",
  'Script error, "DECORATE" line 12:',
  "Expected '}' but got 'Foo'",
  "Execution could not continue.",
  "2 errors while parsing DECORATE scripts",
  "Init game engine.",
].join("\n");

describe("parseStartupErrors", () => {
  it("extracts compile/fatal error lines and ignores normal startup chatter", () => {
    const errs = parseStartupErrors(SAMPLE);
    expect(errs).toEqual([
      'Script error, "DECORATE" line 12:',
      "Expected '}' but got 'Foo'",
      "Execution could not continue.",
      "2 errors while parsing DECORATE scripts",
    ]);
    expect(errs).not.toContain("adding doom2.wad, 2919 lumps");
  });

  it("returns nothing for a clean log", () => {
    expect(parseStartupErrors("adding doom2.wad\nInit game engine.\nplaying")).toEqual([]);
  });

  it("handles CRLF line endings", () => {
    expect(parseStartupErrors("ok\r\nScript error, foo\r\nok")).toEqual(["Script error, foo"]);
  });
});

describe("tailLines", () => {
  it("returns the last n non-empty lines", () => {
    expect(tailLines("a\n\nb\nc\n\n", 2)).toEqual(["b", "c"]);
  });

  it("defaults to 40 lines and skips blanks", () => {
    const log = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n\n");
    const out = tailLines(log);
    expect(out).toHaveLength(40);
    expect(out[out.length - 1]).toBe("line 99");
  });
});

describe("crashLogPath", () => {
  it("derives <log>.crash from the console-log path (matches mcp_crash.cpp)", () => {
    expect(crashLogPath("/x/mcp-bridge-7777.log")).toBe("/x/mcp-bridge-7777.log.crash");
    expect(crashLogPath("C:/tmp/inst1.log")).toBe("C:/tmp/inst1.log.crash");
  });
});

describe("readLogWindow", () => {
  const LOG = ["one", "__MCPDONE_1__", "Degreelessness Mode ON", "", "two", "partial"].join("\n");

  it("tails the last maxLines, skipping sentinels, blanks and a half-written last line", () => {
    expect(readLogWindow(LOG, { maxLines: 2 })).toEqual({
      lines: [
        { line: 3, text: "Degreelessness Mode ON" },
        { line: 5, text: "two" },
      ],
      nextLine: 5,
      omitted: 1,
    });
  });

  it("filters by a case-insensitive pattern", () => {
    expect(readLogWindow(LOG, { pattern: "degreeless", maxLines: 10 }).lines).toEqual([
      { line: 3, text: "Degreelessness Mode ON" },
    ]);
  });

  it("reads forward from sinceLine, resuming at the last line returned when capped", () => {
    expect(readLogWindow(LOG, { sinceLine: 1, maxLines: 1 })).toEqual({
      lines: [{ line: 3, text: "Degreelessness Mode ON" }],
      nextLine: 3,
      omitted: 1,
    });
    expect(readLogWindow(LOG, { sinceLine: 3, maxLines: 5 })).toEqual({
      lines: [{ line: 5, text: "two" }],
      nextLine: 5,
      omitted: 0,
    });
  });

  it("returns nothing past the end (a relaunch overwrote the log)", () => {
    expect(readLogWindow(LOG, { sinceLine: 99, maxLines: 5 })).toEqual({ lines: [], nextLine: 5, omitted: 0 });
  });

  it("throws on an invalid pattern", () => {
    expect(() => readLogWindow(LOG, { pattern: "(", maxLines: 5 })).toThrow();
  });
});

describe("crashReportPid", () => {
  it("reads the pid line from either platform's report, or undefined", () => {
    expect(crashReportPid("=== MCP ENGINE CRASH ===\nsignal: 11 SIGSEGV\nfault_addr: 0x8\npid: 31337\n\nbacktrace:\n")).toBe(31337);
    expect(crashReportPid("code: 0xc0000005\r\npid: 7\r\n")).toBe(7);
    expect(crashReportPid("no pid here\n#0 pid: 5 in a frame")).toBeUndefined();
  });
});
