import { describe, it, expect } from "vitest";
import { parseStatus, describeStatus } from "../src/parsers/status.js";

const SENTINEL = "__MCPDONE_a1__";

describe("parseStatus", () => {
  it("returns undefined for the legacy bare-echo form (just the sentinel)", () => {
    expect(parseStatus(SENTINEL, SENTINEL)).toBeUndefined();
  });

  it("returns undefined for a line that isn't the status line at all", () => {
    expect(parseStatus("Unknown actor 'DoomImp'", SENTINEL)).toBeUndefined();
  });

  it("parses every key=value field off the status line", () => {
    const line = `${SENTINEL} paused=0 menu=off console=up gamestate=level player=alive spectating=0 demo=0 automap=0 chat=0 demorec=0 pending=0 health=100 armor=0`;
    expect(parseStatus(line, SENTINEL)).toEqual({
      paused: "0",
      menu: "off",
      console: "up",
      gamestate: "level",
      player: "alive",
      spectating: "0",
      demo: "0",
      automap: "0",
      chat: "0",
      demorec: "0",
      pending: "0",
      health: "100",
      armor: "0",
    });
  });

  it("skips a token with no (or leading) '=' and keeps the rest", () => {
    const line = `${SENTINEL} paused=0 garbage menu=on`;
    expect(parseStatus(line, SENTINEL)).toEqual({ paused: "0", menu: "on" });
  });
});

describe("describeStatus", () => {
  it("returns undefined when nothing is unusual", () => {
    const status = {
      paused: "0",
      menu: "off",
      console: "up",
      gamestate: "level",
      player: "alive",
      spectating: "0",
      demo: "0",
      automap: "0",
      chat: "0",
      demorec: "0",
      pending: "0",
    };
    expect(describeStatus(status)).toBeUndefined();
  });

  it("names an open menu by class and reports every other unusual condition", () => {
    const status = {
      paused: "1",
      menu: "on",
      menuclass: "DOptionMenu",
      console: "down",
      gamestate: "intermission",
      player: "dead",
      spectating: "1",
      demo: "1",
      automap: "1",
      chat: "1",
      demorec: "1",
      pending: "1",
    };
    expect(describeStatus(status)).toBe(
      "Engine state: paused, a menu is open (DOptionMenu), console is down, " +
        "not in a level (intermission), player is dead, spectating, " +
        "playing back a demo, automap is open, chat input is open, " +
        "recording a demo, a map/save/demo load is pending.",
    );
  });

  it("reports an open menu with no class, and no player as distinct from a dead one", () => {
    const status = {
      paused: "0",
      menu: "on",
      console: "up",
      gamestate: "level",
      player: "none",
      spectating: "0",
      demo: "0",
      automap: "0",
    };
    expect(describeStatus(status)).toBe("Engine state: a menu is open, no player.");
  });

  it("treats a field the connected bridge never sent as normal, not unusual", () => {
    const status = {
      paused: "0",
      menu: "off",
      console: "up",
      gamestate: "level",
      player: "alive",
      spectating: "0",
      // demo omitted entirely -- an older bridge that predates a field
      automap: "0",
    };
    expect(describeStatus(status)).toBeUndefined();
  });
});
