import { describe, it, expect } from "vitest";
import {
  makeSentinel,
  statusRequest,
  withSentinel,
  lineContainsSentinel,
  stripForeignSentinels,
} from "../src/correlation/sentinel.js";

describe("sentinel", () => {
  it("creates a unique-looking marker from an id", () => {
    expect(makeSentinel("a1")).toBe("__MCPDONE_a1__");
  });

  it("builds the mcp_status form of a correlator", () => {
    expect(statusRequest("__MCPDONE_a1__")).toBe("mcp_status __MCPDONE_a1__");
  });

  it("appends an echo of the sentinel to a command by default", () => {
    expect(withSentinel("summon Imp", "__MCPDONE_a1__", false)).toBe(
      "summon Imp ; echo __MCPDONE_a1__",
    );
  });

  it("rides the sentinel on mcp_status when status is requested", () => {
    expect(withSentinel("summon Imp", "__MCPDONE_a1__", true)).toBe(
      "summon Imp ; mcp_status __MCPDONE_a1__",
    );
  });

  it("detects the sentinel within a console line", () => {
    expect(lineContainsSentinel("__MCPDONE_a1__", "__MCPDONE_a1__")).toBe(true);
    expect(lineContainsSentinel("some other text", "__MCPDONE_a1__")).toBe(false);
  });
});

describe("stripForeignSentinels", () => {
  const own = "__MCPDONE_b__";
  it("leaves a message without a foreign reply line untouched", () => {
    expect(stripForeignSentinels("real line", own)).toBe("real line");
    expect(stripForeignSentinels(`${own} paused=0`, own)).toBe(`${own} paused=0`);
    // dumphud quotes on-screen notify text mid-line; that is output, not plumbing.
    const hud = "MCP_HUD\ntext 0 0 __MCPDONE_a__ paused=0\nimage STBAR 0 168";
    expect(stripForeignSentinels(hud, own)).toBe(hud);
  });

  it("drops a late foreign reply, alone or mixed with real lines", () => {
    expect(stripForeignSentinels("__MCPDONE_a__ paused=1", own)).toBeUndefined();
    expect(stripForeignSentinels("  __MCPDONE_a__\n", own)).toBeUndefined();
    expect(stripForeignSentinels("real\n__MCPDONE_a__ paused=1", own)).toBe("real");
  });
});
