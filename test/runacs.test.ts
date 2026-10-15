import { describe, it, expect } from "vitest";
import { parseRunAcs, runAcsText } from "../src/parsers/runacs.js";

describe("parseRunAcs", () => {
  it("parses the reply line and keeps the script's own output, colour-stripped", () => {
    const got = parseRunAcs(["\x1cGhello \n\n", "MCP_RUNACS module=3 scripts=2 started=named deferred=1"]);
    expect(got).toEqual({
      reply: { module: 3, scripts: 2, started: "named", deferred: true },
      printed: ["hello"],
    });
  });

  it("echoes the started script exactly as the engine printed it", () => {
    const got = parseRunAcs(["MCP_RUNACS module=0 scripts=1 started=007 deferred=0"]);
    expect(got?.reply).toEqual({ module: 0, scripts: 1, started: "007", deferred: false });
    expect(got?.printed).toEqual([]);
  });

  it("isn't fooled by a snippet print that starts with the reply's tag", () => {
    const got = parseRunAcs(["MCP_RUNACS hello from my script", "MCP_RUNACS module=2 scripts=1 started=1 deferred=1"]);
    expect(got?.reply).toEqual({ module: 2, scripts: 1, started: "1", deferred: true });
  });

  it("returns undefined without a well-formed reply line", () => {
    expect(parseRunAcs(["error netgame"])).toBeUndefined();
    expect(parseRunAcs(["MCP_RUNACS oops"])).toBeUndefined();
  });
});

describe("runAcsText", () => {
  const reply = { module: 2, scripts: 3, started: "1", deferred: false };
  const SAVE = /^save_game refuses until the map changes/;

  it("leads with the load line and the snippet's prints, and ends on the save warning", () => {
    const lines = runAcsText({ reply, printed: ["hi"] }, 0).split("\n");
    expect(lines.slice(0, 2)).toEqual(["loaded snippet as module 2 (3 script(s)), started 1", "hi"]);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toMatch(SAVE);
  });

  it("adds the log read after stepping, or says there was none", () => {
    const withLog = runAcsText({ reply, printed: [] }, 5, ["late"]).split("\n");
    expect(withLog.slice(1, 3)).toEqual(["log after 5 tic(s):", "late"]);
    const noLog = runAcsText({ reply, printed: [] }, 5).split("\n");
    expect(noLog[1]).toBe("ran 5 tic(s); no engine log to read");
  });

  it("flags scripts that fire later", () => {
    const lines = runAcsText({ reply: { ...reply, deferred: true }, printed: [] }, 0).split("\n");
    expect(lines[1]).toMatch(/^The snippet has DEATH\/ENTER\/RESPAWN/);
    expect(lines[2]).toMatch(SAVE);
  });
});
