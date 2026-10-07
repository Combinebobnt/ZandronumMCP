import { describe, it, expect } from "vitest";
import { matchLines, parseKv, parseKvLines, firstError } from "../src/parsers/lines.js";
import { parsePlayers } from "../src/parsers/players.js";
import { parseFindActors } from "../src/parsers/actorstate.js";

describe("matchLines", () => {
  it("splits multi-line chunks, trims, and maps only matching lines", () => {
    const got = matchLines(["  a 1\r\nb 2", "a 3"], /^a (\d)$/, (m) => Number(m[1]));
    expect(got).toEqual([1, 3]);
  });
});

describe("parseKv", () => {
  it("coerces numbers, keeps strings, and skips bare tokens", () => {
    expect(parseKv("slot=0 x=-1.5 weapon=Pistol junk =bad")).toEqual({ slot: 0, x: -1.5, weapon: "Pistol" });
  });

  it("takes name= as the rest of the line, even with spaces or '='", () => {
    expect(parseKv("slot=1 name=Big Bot a=b")).toEqual({ slot: 1, name: "Big Bot a=b" });
  });

  it("handles a leading name= and keeps a numeric name a string", () => {
    expect(parseKv("name=123")).toEqual({ name: "123" });
  });
});

describe("parseKvLines / firstError", () => {
  it("parses only lines with the given tag", () => {
    expect(parseKvLines(["MCP_X", "view angle=90 pitch=-10", "viewer a=1"], "view")).toEqual([
      { angle: 90, pitch: -10 },
    ]);
  });

  it("finds the first error line, or none", () => {
    expect(firstError(["ok", "error no actor with tid 5", "error later"])).toBe("no actor with tid 5");
    expect(firstError(["ok"])).toBeUndefined();
  });
});

describe("parsePlayers", () => {
  it("returns one record per player line", () => {
    const players = parsePlayers([
      "MCP_PLAYERS",
      "player slot=0 bot=0 spec=0 deadspec=0 state=live hp=100 cheats=2 ping=0 name=Player",
      "player slot=1 bot=1 spec=0 deadspec=0 state=live cheats=0 ping=0 name=Doom Guy",
    ]);
    expect(players).toHaveLength(2);
    expect(players[1]).toMatchObject({ slot: 1, bot: 1, name: "Doom Guy" });
  });
});

describe("parseFindActors", () => {
  it("expands flag letters, ignoring unknown and '-' ones", () => {
    const found = parseFindActors([
      "MCP_FOUND",
      "found class=DoomImp tid=5 hp=60 flags=msoz target=player0",
      "found class=Column tid=0 hp=1000 flags=-",
      "found class=Odd tid=0",
    ]);
    expect(found.actors[0]).toMatchObject({ class: "DoomImp", flags: "monster,shootable,solid", target: "player0" });
    expect(found.actors[1].flags).toBe("");
    expect(found.actors[2].flags).toBeUndefined();
    expect(found.truncated).toBeUndefined();
  });

  it("reports truncation", () => {
    const found = parseFindActors(["found class=A tid=0", "truncated shown=1 total=9"]);
    expect(found.truncated).toEqual({ shown: 1, total: 9 });
  });
});
