import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { startHarness, collectTools, type Harness } from "./fakes/tool-harness.js";
import { FakeBridge } from "./fakes/fake-bridge.js";
import { InstanceRegistry } from "./../src/process/registry.js";
import type { ContextIo, ServerConfig } from "../src/context.js";
import { buildWad, sectorsLump, doomLinedefsLump, sidedefsLump, vertexesLump } from "./fakes/wad-builder.js";
import { buildBehaviorAcse } from "./fakes/acs-builder.js";

/**
 * Drives every registered tool through a real MCP client/server pair — the
 * layer that used to be excluded from coverage as "just wiring".
 */

let bridge: FakeBridge | undefined;
let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  await bridge?.close();
  bridge = undefined;
});

interface LiveOptions {
  caps?: string[];
  responses?: Record<string, string[]>;
  config?: Partial<ServerConfig>;
  io?: Partial<ContextIo>;
}

/** Harness wired to a fake engine bridge on a real loopback port. */
async function live(opts: LiveOptions = {}): Promise<Harness> {
  bridge = await FakeBridge.start({
    hello: { v: 1, t: "hello", engine: "fake", caps: opts.caps ?? ["cmd", "event", "time"] },
  });
  for (const [match, lines] of Object.entries(opts.responses ?? {})) bridge.respondTo(match, lines);
  harness = await startHarness({
    config: { basePort: bridge.port, ...opts.config },
    io: opts.io,
  });
  return harness;
}

/** Wait for a fire-and-forget send to reach the fake bridge. */
async function settle(done: () => boolean, tries = 100): Promise<void> {
  for (let i = 0; i < tries && !done(); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(done()).toBe(true);
}

/** Harness with no engine — for the file-backed and process-management tools. */
async function offline(config: Partial<ServerConfig> = {}, io: Partial<ContextIo> = {}) {
  harness = await startHarness({ config, io });
  return harness;
}

const WAD = buildWad("PWAD", [
  { name: "MAP01" },
  { name: "THINGS" },
  {
    name: "LINEDEFS",
    data: doomLinedefsLump([
      { v1: 0, v2: 1, flags: 1, special: 0, tag: 3, front: 0, back: 0xffff },
    ]),
  },
  {
    name: "SIDEDEFS",
    data: sidedefsLump([{ xoff: 0, yoff: 0, upper: "-", lower: "-", middle: "BRICK1", sector: 0 }]),
  },
  { name: "VERTEXES", data: vertexesLump([{ x: 0, y: 0 }, { x: 64, y: 0 }]) },
  {
    name: "SECTORS",
    data: sectorsLump([
      { floor: 0, ceil: 128, floorTex: "FLAT1", ceilTex: "F_SKY1", light: 160, special: 0, tag: 3 },
    ]),
  },
]);

const wadIo = { readFileSync: () => WAD };

describe("console, cheat and script tools", () => {
  it("runs a raw command and returns its output", async () => {
    const h = await live({ responses: { version: ["Zandronum 3.2.1"] } });
    expect(await h.text("run_command", { text: "version" })).toBe("Zandronum 3.2.1");
  });

  it("reports silent commands as (no output)", async () => {
    const h = await live();
    expect(await h.text("run_command", { text: "nothing" })).toBe("(no output)");
  });

  it("lists actor classes as structured data", async () => {
    const h = await live({
      responses: {
        dumpactors: ["DoomImp\t3001\t5\tDoom\tzandronum.pk3:actors/imp.txt"],
      },
    });
    const result = await h.call("list_actor_classes");
    expect(result.structuredContent?.actors).toEqual([
      { name: "DoomImp", edNum: 3001, spawnId: 5, filter: "Doom", source: "zandronum.pk3:actors/imp.txt" },
    ]);
  });

  it("summons with the verb matching the requested kind", async () => {
    const h = await live();
    await h.text("summon", { className: "DoomImp" });
    await h.text("summon", { className: "DoomImp", kind: "friend" });
    await h.text("summon", { className: "DoomImp", kind: "foe" });
    const sent = bridge!.received.filter((m) => m.t === "cmd").map((m) => m.text ?? "");
    expect(sent[0]).toMatch(/^summon DoomImp/);
    expect(sent[1]).toMatch(/^summonfriend DoomImp/);
    expect(sent[2]).toMatch(/^summonfoe DoomImp/);
  });

  it("falls back to a confirmation when summon prints nothing", async () => {
    const h = await live();
    expect(await h.text("summon", { className: "DoomImp" })).toBe("summoned DoomImp");
  });

  it("gives and takes items with and without an amount", async () => {
    const h = await live({ responses: { "give Clip 50": ["gave it"] } });
    expect(await h.text("give", { item: "Clip", amount: 50 })).toBe("gave it");
    expect(await h.text("give", { item: "Berserk" })).toBe("gave Berserk");
    expect(await h.text("take", { item: "Clip", amount: 5 })).toBe("took Clip");
    expect(await h.text("take", { item: "Berserk" })).toBe("took Berserk");
  });

  it("loads a map by lump name", async () => {
    const h = await live({ responses: { "map MAP07": ["MAP07 - Dead Simple"] } });
    expect(await h.text("load_map", { mapName: "MAP07" })).toBe("MAP07 - Dead Simple");
    expect(await h.text("load_map", { mapName: "E1M1" })).toBe("loaded E1M1");
  });

  it("lists running scripts", async () => {
    const h = await live({ responses: { scriptstat: ["script 5: Running"] } });
    const result = await h.call("list_running_scripts");
    expect(result.structuredContent?.scripts).toEqual([{ number: 5, name: null, state: "Running" }]);
  });

  it("pukes scripts by number and by name", async () => {
    const h = await live();
    expect(await h.text("run_script", { script: 12, args: [1, 2] })).toBe("ran 12");
    expect(await h.text("run_script", { script: "OpenDoor", always: true })).toBe("ran OpenDoor");
    const sent = bridge!.received.filter((m) => m.t === "cmd").map((m) => m.text ?? "");
    expect(sent[0]).toMatch(/^puke 12 1 2/);
    expect(sent[1]).toMatch(/^pukename "OpenDoor" always/);
  });

  it("returns a screenshot as an image", async () => {
    const h = await live();
    const result = await h.call("screenshot");
    expect(result.content?.[0]).toMatchObject({ type: "image", mimeType: "image/png", data: "UE5H" });
  });
});

describe("input tools", () => {
  it("sends a single menu key", async () => {
    const h = await live();
    const received = bridge!.waitForEvent();
    expect(await h.text("menu_key", { key: "down" })).toBe("sent down");
    expect((await received).evtype).toBeGreaterThanOrEqual(0);
  });

  it("sends a sequence of menu keys", async () => {
    const h = await live();
    expect(await h.text("menu_nav", { steps: ["down", "down", "enter"] })).toBe(
      "sent 3 key(s): down down enter",
    );
    await settle(() => bridge!.events.length === 3);
  });

  it("types a string one character at a time", async () => {
    const h = await live();
    expect(await h.text("menu_text", { text: "hi" })).toBe('typed "hi"');
    await settle(() => bridge!.events.length === 2);
  });

  it("opens, navigates and screenshots a menu", async () => {
    const h = await live({ responses: { menu_options: ["opened"] } });
    const result = await h.call("verify_menu", { open: "menu_options", steps: ["down"] });
    expect(result.content?.[0]).toMatchObject({ type: "image" });
    await settle(() => bridge!.events.length === 1);
  });

  it("screenshots without opening or navigating when neither is asked for", async () => {
    const h = await live();
    const result = await h.call("verify_menu");
    expect(result.content?.[0]).toMatchObject({ type: "image" });
    // No `open` command, no key events — the capture itself is stubbed out.
    expect(bridge!.received).toHaveLength(0);
  });

  it("reports missing input support on an older bridge", async () => {
    const h = await live({ caps: ["cmd"] });
    for (const [tool, args] of [
      ["menu_key", { key: "up" }],
      ["menu_nav", { steps: ["up"] }],
      ["menu_text", { text: "x" }],
      ["verify_menu", { steps: ["up"] }],
    ] as const) {
      const result = await h.call(tool, args as Record<string, unknown>);
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toMatch(/no input support/);
    }
  });
});

describe("time control tools", () => {
  it("pauses and resumes", async () => {
    const h = await live();
    expect(await h.text("set_pause", { paused: true })).toBe("paused");
    expect(await h.text("set_pause", { paused: false })).toBe("resumed");
    await settle(() => bridge!.pauses.length === 2);
    expect(bridge!.pauses).toEqual([1, 0]);
  });

  it("steps the simulation forward and re-pauses", async () => {
    const h = await live();
    expect(await h.text("step", { tics: 70 })).toBe("advanced ~70 tic(s)");
    await settle(() => bridge!.pauses.length === 2);
    expect(bridge!.pauses).toEqual([0, 1]);
  });

  it("reports missing time support on an older bridge", async () => {
    const h = await live({ caps: ["cmd"] });
    expect((await h.call("set_pause", { paused: true })).content?.[0]?.text).toMatch(/no time-control/);
    expect((await h.call("step")).content?.[0]?.text).toMatch(/no time-control/);
  });
});

describe("ACS variable tools", () => {
  it("reads and writes world/global variables", async () => {
    const h = await live({
      responses: { getacsvar: ["acsvar world 5 = 42"], setacsvar: ["acsvar world 5 = 7"] },
    });
    const get = await h.call("get_acs_var", { scope: "world", index: 5 });
    expect(get.structuredContent).toEqual({ scope: "world", index: 5, value: 42 });
    const set = await h.call("set_acs_var", { scope: "world", index: 5, value: 7 });
    expect(set.content?.[0]?.text).toBe("world[5] = 7");
  });

  it("surfaces engine complaints when a variable read or write yields nothing", async () => {
    const h = await live({ responses: { getacsvar: ["index out of range (0-255)"] } });
    const get = await h.call("get_acs_var", { scope: "world", index: 999 });
    expect(get.isError).toBe(true);
    expect(get.content?.[0]?.text).toBe("index out of range (0-255)");

    const set = await h.call("set_acs_var", { scope: "global", index: 1, value: 2 });
    expect(set.isError).toBe(true);
    expect(set.content?.[0]?.text).toBe("set failed");
  });

  it("falls back to a generic message when the engine says nothing at all", async () => {
    const h = await live();
    expect((await h.call("get_acs_var", { scope: "world", index: 0 })).content?.[0]?.text).toBe("no value");
  });

  it("lists non-zero vars, optionally filtered by scope", async () => {
    const h = await live({
      responses: { dumpacsvars: ["acsvar world 0 = 1", "acsvar global 2 = 100"] },
    });
    const all = await h.call("list_acs_vars");
    expect(all.content?.[0]?.text).toBe("2 non-zero ACS var(s)");
    const world = await h.call("list_acs_vars", { scope: "world" });
    expect(world.content?.[0]?.text).toBe("1 non-zero ACS var(s)");
  });
});

describe("map-scope ACS tools", () => {
  it("lists loaded modules", async () => {
    const h = await live({ responses: { dumpmodules: ["module 0 ACSLEVEL"] } });
    expect(await h.text("list_modules")).toBe("1 module(s)");
  });

  it("gets and sets map variables and array elements", async () => {
    const h = await live({
      responses: {
        getmapvar: ["mapvar deathtoll = 42"],
        setmapvar: ["mapvar deathtoll = 9"],
        getmaparray: ["maparray Credits[2] = 500"],
        setmaparray: ["maparray Credits[2] = 7"],
      },
    });
    expect(await h.text("get_map_var", { name: "deathtoll" })).toBe("42");
    expect(await h.text("set_map_var", { name: "deathtoll", value: 9 })).toBe("deathtoll = 9");
    expect(await h.text("get_map_array", { name: "Credits", index: 2 })).toBe("500");
    expect(await h.text("set_map_array", { name: "Credits", index: 2, value: 7 })).toBe("Credits[2] = 7");
  });

  it("reports map vars and arrays that don't exist", async () => {
    const h = await live();
    for (const [tool, args, expected] of [
      ["get_map_var", { name: "Nope" }, "map var 'Nope' not found"],
      ["set_map_var", { name: "Nope", value: 1 }, "map var 'Nope' not found"],
      ["get_map_array", { name: "Nope", index: 0 }, "map array 'Nope' not found"],
      ["set_map_array", { name: "Nope", index: 0, value: 1 }, "map array 'Nope' not found"],
    ] as const) {
      const result = await h.call(tool, args as Record<string, unknown>);
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toBe(expected);
    }
  });
});

describe("ACS source and bytecode tools", () => {
  const sources: Record<string, string> = {
    "main.acs": "#define GOLD 7\nscript 1 OPEN { }\nfunction void Give(void) { }",
  };
  const acsIo = {
    readdirSync: () => ["main.acs"],
    readTextSync: (p: string) => sources[path.basename(p)],
  };

  it("summarises an indexed ACS source directory", async () => {
    const h = await offline({ acsSrc: "/mods/acs" }, acsIo);
    const result = await h.call("acs_index");
    expect(result.structuredContent).toMatchObject({ scripts: 1, functions: 1, defines: 1 });
  });

  it("resolves a symbol to its source location", async () => {
    const h = await offline({}, acsIo);
    const result = await h.call("find_acs_symbol", { ref: "Give", dir: "/mods/acs" });
    expect(result.content?.[0]?.text).toBe("1 match(es) for Give");
  });

  it("errors when no ACS source directory is configured", async () => {
    const h = await offline();
    const result = await h.call("acs_index");
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/No ACS source dir/);
  });

  it("reads names out of compiled bytecode", async () => {
    const wad = buildWad("PWAD", [
      { name: "BEHAVIOR", data: buildBehaviorAcse(["GiveCredits"], ["OpenDoor"]) },
    ]);
    const h = await offline({}, { readFileSync: () => wad });
    const result = await h.call("behavior_names", { file: "/mods/x.wad" });
    expect(result.structuredContent).toEqual({
      functions: ["GiveCredits"],
      namedScripts: ["OpenDoor"],
    });
  });
});

describe("savegame and demo tools", () => {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  function textChunk(key: string, val: string): Buffer {
    const data = Buffer.concat([Buffer.from(key, "latin1"), Buffer.from([0]), Buffer.from(val, "latin1")]);
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0);
    b.write("tEXt", 4, "latin1");
    data.copy(b, 8);
    return b;
  }
  const save = Buffer.concat([SIG, textChunk("Title", "My Save"), textChunk("Current Map", "MAP07")]);

  it("lists savegames with metadata read from the file", async () => {
    const h = await offline(
      { saveDir: "/saves" },
      { readdirSync: () => ["a.zds", "notes.txt"], readFileSync: () => save },
    );
    const result = await h.call("list_saves");
    expect(result.content?.[0]?.text).toBe("1 save(s) in /saves");
    expect(result.structuredContent?.saves).toMatchObject([{ title: "My Save", map: "MAP07" }]);
  });

  it("errors when no save directory can be determined", async () => {
    const h = await offline();
    expect((await h.call("list_saves")).isError).toBe(true);
  });

  it("treats a save without the engine's confirmation as a failure", async () => {
    const h = await live({ responses: { "save good": ["Game saved."] } });
    const ok = await h.call("save_game", { name: "good", description: "a slot" });
    expect(ok.isError).toBe(false);
    expect(ok.content?.[0]?.text).toBe("Game saved.");

    const bad = await h.call("save_game", { name: "bad" });
    expect(bad.isError).toBe(true);
    expect(bad.content?.[0]?.text).toBe("(no output)");
  });

  it("loads a savegame and plays a demo", async () => {
    const h = await live({ responses: { "load slot1": ["Loading..."], "playdemo d1": ["Playing"] } });
    expect(await h.text("load_game", { name: "slot1" })).toBe("Loading...");
    expect(await h.text("load_game", { name: "other" })).toBe("(loaded)");
    expect(await h.text("play_demo", { name: "d1" })).toBe("Playing");
    expect(await h.text("play_demo", { name: "other" })).toBe("(playing)");
  });
});

describe("live state tools", () => {
  it("reads player state", async () => {
    const h = await live({
      responses: {
        currentpos: [
          "Current player position: (128.500,-64.000,0.000), angle: 270.000, floorheight: -8.000, sector:12, lightlevel: 144",
        ],
      },
    });
    const result = await h.call("player_state");
    expect(result.structuredContent).toMatchObject({ sector: 12, light: 144, x: 128.5 });
  });

  it("reports when there is no player", async () => {
    const h = await live();
    const result = await h.call("player_state");
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/no player/);
  });

  it("reads actor state for the player and for a TID", async () => {
    const h = await live({
      responses: { dumpactor: ["MCP_ACTOR", "class DoomPlayer", "health 100", "state TNT1 A 0"] },
    });
    const player = await h.call("actor_state");
    expect(player.structuredContent).toMatchObject({ class: "DoomPlayer", health: 100 });
    await h.call("actor_state", { tid: 42 });
    const sent = bridge!.received.filter((m) => m.t === "cmd").map((m) => m.text ?? "");
    expect(sent[0]).toMatch(/^dumpactor ;/);
    expect(sent[1]).toMatch(/^dumpactor 42/);
  });

  it("reports a missing actor", async () => {
    const h = await live();
    const result = await h.call("actor_state", { tid: 999 });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/no actor/);
  });

  it("reads the HUD", async () => {
    const h = await live({
      responses: {
        dumphud: ["MCP_HUD", "text 100 50 Press space", "image 10 20 MEDIA0", "msg 0 0.5 0.9 70 Credits"],
      },
    });
    const result = await h.call("read_hud");
    expect(result.content?.[0]?.text).toBe("1 strings, 1 images, 1 hud messages");
  });

  it("lists nearby actors, with and without an explicit radius", async () => {
    const h = await live({ responses: { actorsnear: ["MCP_ACTORS", "near DoomImp 60 100.0 200.0 TROO"] } });
    expect(await h.text("actors_near")).toBe("1 actor(s) nearby");
    await h.call("actors_near", { radius: 256 });
    const sent = bridge!.received.filter((m) => m.t === "cmd").map((m) => m.text ?? "");
    expect(sent[1]).toMatch(/^actorsnear 256/);
  });

  it("inspects the aimed target, or reports none", async () => {
    const h = await live({ responses: { linetarget: ["Target=DoomImp, Health=60, Spawnhealth=60"] } });
    const hit = await h.call("inspect_target");
    expect(hit.structuredContent).toMatchObject({ target: "DoomImp", health: 60 });
  });

  it("reports no target in view", async () => {
    const h = await live();
    expect(await h.text("inspect_target")).toBe("no target in view");
  });
});

describe("script listing and profiling tools", () => {
  it("lists scripts and functions", async () => {
    const h = await live({
      responses: { dumpscripts: ["script 0 1 - 1 0"], dumpfunctions: ["function 0 0 GiveCredits"] },
    });
    expect(await h.text("list_scripts")).toBe("1 script(s)");
    expect(await h.text("list_functions")).toBe("1 function(s)");
  });

  it("profiles scripts with and without sort/limit", async () => {
    const h = await live({ responses: { acsprofile: ["MOD name 1 2 3 4 5"] } });
    expect(await h.text("profile_scripts")).toBe("1 profiled");
    await h.call("profile_scripts", { sort: "avg" });
    await h.call("profile_scripts", { sort: "total", limit: 5 });
    const sent = bridge!.received.filter((m) => m.t === "cmd").map((m) => m.text ?? "");
    expect(sent[0]).toMatch(/^acsprofile ;/);
    expect(sent[1]).toMatch(/^acsprofile avg ;/);
    expect(sent[2]).toMatch(/^acsprofile total 5 ;/);
  });

  it("profiles a time window, clearing first", async () => {
    const h = await live({ responses: { acsprofile: ["MOD name 1 2 3 4 5"] } });
    expect(await h.text("profile_window", { seconds: 2 })).toBe("1 profiled over 2s");
    await h.call("profile_window", { sort: "runs", limit: 3 });
    const sent = bridge!.received.filter((m) => m.t === "cmd").map((m) => m.text ?? "");
    expect(sent[0]).toMatch(/^acsprofile clear/);
    expect(sent[3]).toMatch(/^acsprofile runs 3 ;/);
  });
});

describe("renderer inspection tools", () => {
  const responses = {
    dumprenderer: [
      "MCP_RENDERER",
      "renderer=opengl",
      "screen_width=1920",
      "view_x=0",
      "statusbar_y=1048",
      "crosshair=1",
    ],
  };

  it("returns renderer, viewport and HUD slices of the same dump", async () => {
    const h = await live({ responses });
    expect((await h.call("renderer_info")).structuredContent).toMatchObject({
      renderer: "opengl",
      screen_width: 1920,
    });
    expect((await h.call("viewport_info")).structuredContent).toMatchObject({ view_x: 0 });
    expect((await h.call("hud_info")).structuredContent).toMatchObject({
      statusbar_y: 1048,
      crosshair: 1,
    });
  });
});

describe("map geometry tools", () => {
  it("summarises a map read straight from a WAD", async () => {
    const h = await offline({ iwad: "/game/doom2.wad" }, wadIo);
    const result = await h.call("map_info", { map: "MAP01" });
    expect(result.structuredContent).toEqual({
      format: "doom",
      sectors: 1,
      linedefs: 1,
      sidedefs: 1,
      vertices: 2,
    });
  });

  it("errors when no WAD is configured or passed", async () => {
    const h = await offline();
    const result = await h.call("map_info", { map: "MAP01" });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/No WAD specified/);
  });

  it("returns a sector by index", async () => {
    const h = await offline({ iwad: "/game/doom2.wad" }, wadIo);
    const result = await h.call("get_sector", { map: "MAP01", index: 0 });
    expect(result.structuredContent?.sector).toMatchObject({ tag: 3, light: 160 });
  });

  it("reports an out-of-range sector index", async () => {
    const h = await offline({ iwad: "/game/doom2.wad" }, wadIo);
    const result = await h.call("get_sector", { map: "MAP01", index: 99 });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toBe("No sector 99 (map has 1).");
  });

  it("returns a linedef with its sidedefs resolved", async () => {
    const h = await offline({ iwad: "/game/doom2.wad" }, wadIo);
    const result = await h.call("get_linedef", { map: "MAP01", index: 0 });
    const { line, sides } = result.structuredContent as { line: Record<string, number>; sides: unknown[] };
    expect(line.tag).toBe(3);
    expect(sides).toHaveLength(1); // the -1 back side is filtered out
  });

  it("reports an out-of-range linedef index", async () => {
    const h = await offline({ iwad: "/game/doom2.wad" }, wadIo);
    const result = await h.call("get_linedef", { map: "MAP01", index: 99 });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toBe("No linedef 99 (map has 1).");
  });

  it("finds sectors by tag", async () => {
    const h = await offline({ iwad: "/game/doom2.wad" }, wadIo);
    expect(await h.text("find_sectors_by_tag", { map: "MAP01", tag: 3 })).toBe("1 sector(s) with tag 3");
    expect(await h.text("find_sectors_by_tag", { map: "MAP01", tag: 9 })).toBe("0 sector(s) with tag 9");
  });
});

describe("process management tools", () => {
  it("refuses to launch without an engine configured", async () => {
    const h = await offline();
    const result = await h.call("launch_instance");
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/Set ZANDRONUM_EXE/);
  });

  it("refuses to launch an engine path that doesn't exist", async () => {
    const h = await offline({ exe: "/engine/zandronum" }, { existsSync: () => false });
    const result = await h.call("launch_instance");
    expect(result.content?.[0]?.text).toMatch(/not found at/);
  });

  it("refuses to launch a build without the MCP bridge", async () => {
    const h = await offline(
      { exe: "/engine/zandronum" },
      { existsSync: () => true, hasBridge: () => false },
    );
    const result = await h.call("launch_instance");
    expect(result.content?.[0]?.text).toMatch(/has no MCP bridge/);
  });

  it("launches, attaches, and remembers the port it picked", async () => {
    bridge = await FakeBridge.start();
    const registry = new InstanceRegistry();
    harness = await startHarness({
      config: { exe: "/engine/zandronum", basePort: bridge.port },
      io: {
        existsSync: () => true,
        hasBridge: () => true,
        findFreePort: (start) => Promise.resolve(start),
        launchIo: {
          spawn: () => ({ pid: undefined, kill: () => {} }),
          waitForPort: () => Promise.resolve(),
          clearQuarantine: () => {},
        },
      },
      registry,
    });
    const result = await harness.call("launch_instance");
    expect(result.content?.[0]?.text).toBe(`launched instance 1 on bridge port ${bridge.port}`);
    expect(harness.ctx.logPathFor(1)).toBe(path.join("/engine", `mcp-bridge-${bridge.port}.log`));
  });

  it("surfaces compile errors from the engine log when the bridge never opens", async () => {
    const h = await offline(
      { exe: "/engine/zandronum" },
      {
        existsSync: () => true,
        hasBridge: () => true,
        readTextSync: () => "Script error, \"DECORATE\" line 7:\nUnknown actor 'Foo'",
        launchIo: {
          spawn: () => ({ pid: 1234, kill: () => {} }),
          waitForPort: () => Promise.reject(new Error("bridge port never opened")),
          clearQuarantine: () => {},
        },
      },
    );
    const result = await h.call("launch_instance");
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/Engine log shows:[\s\S]*Unknown actor/);
  });

  it("says so when a failed launch left no explanation in the log", async () => {
    const h = await offline(
      { exe: "/engine/zandronum" },
      {
        existsSync: (p: string) => !p.endsWith(".log"),
        hasBridge: () => true,
        launchIo: {
          spawn: () => ({ pid: 1234, kill: () => {} }),
          // A non-Error rejection must still be reported, not swallowed.
          waitForPort: () => Promise.reject("boom"),
          clearQuarantine: () => {},
        },
      },
    );
    const result = await h.call("launch_instance");
    expect(result.content?.[0]?.text).toMatch(/failed to come up: boom\. \(no compile errors/);
  });

  it("reports a log that exists but holds no recognisable errors", async () => {
    const h = await offline(
      { exe: "/engine/zandronum" },
      {
        existsSync: () => true,
        hasBridge: () => true,
        readTextSync: () => "all quiet\n",
        launchIo: {
          spawn: () => ({ pid: 1234, kill: () => {} }),
          waitForPort: () => Promise.reject(new Error("timeout")),
          clearQuarantine: () => {},
        },
      },
    );
    expect((await h.call("launch_instance")).content?.[0]?.text).toMatch(/no compile errors found/);
  });

  it("reports an instance that quit on request", async () => {
    bridge = await FakeBridge.start();
    harness = await startHarness({
      config: { exe: "/engine/zandronum", basePort: bridge.port },
      io: {
        existsSync: () => true,
        hasBridge: () => true,
        launchIo: {
          // A PID that is not (and cannot be) running, so the graceful-quit
          // wait sees the engine already gone on its first poll.
          spawn: () => ({ pid: 0x7ffffff0, kill: () => {} }),
          waitForPort: () => Promise.resolve(),
          clearQuarantine: () => {},
        },
      },
    });
    await harness.call("launch_instance");
    expect(await harness.text("kill_instance")).toBe("instance 1 quit cleanly");
    // The remembered launch goes with it — no log path pinned to that port.
    expect(harness.ctx.logPathFor(1)).toBe(
      path.join("/engine", `mcp-bridge-${bridge.port}.log`),
    );
  });

  it("reports an instance that had to be force-killed", async () => {
    const registry = new InstanceRegistry();
    harness = await startHarness({ registry });
    // Nothing launched: quit() finds no child and reports a forced stop.
    expect(await harness.text("kill_instance")).toBe(
      "instance 1 did not quit on request — force-killed",
    );
  });

  it("resets without an orphan sweep when no engine is configured", async () => {
    const h = await offline();
    expect(await h.text("reset")).toMatch(/ZANDRONUM_EXE unset, so no orphan sweep/);
  });

  it("resets and reports reaped orphans", async () => {
    const h = await offline(
      { exe: "/engine/zandronum" },
      { reap: () => Promise.resolve({ found: [1, 2], killed: [1, 2], survivors: [] }) },
    );
    expect(await h.text("reset")).toBe("Reset complete. Reaped 2 orphaned engine process(es).");
  });

  it("calls out engine processes that survived SIGKILL", async () => {
    const h = await offline(
      { exe: "/engine/zandronum" },
      { reap: () => Promise.resolve({ found: [7], killed: [], survivors: [7] }) },
    );
    expect(await h.text("reset")).toMatch(/survived SIGKILL \(PIDs 7\)/);
  });
});

describe("diagnostic tools", () => {
  it("reports when there is no engine log to read", async () => {
    const h = await offline();
    const result = await h.call("get_startup_errors");
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/No engine log for instance 1/);
  });

  it("reports when the derived log path doesn't exist", async () => {
    const h = await offline({ exe: "/engine/zandronum" }, { existsSync: () => false });
    expect((await h.call("get_startup_errors")).isError).toBe(true);
  });

  it("surfaces error lines from the engine log", async () => {
    const h = await offline(
      { exe: "/engine/zandronum" },
      { existsSync: () => true, readTextSync: () => "ok\nScript error, bad syntax\n" },
    );
    expect(await h.text("get_startup_errors")).toMatch(/Detected 1 error line\(s\)/);
  });

  it("falls back to the log tail when nothing looks like an error", async () => {
    const h = await offline(
      { exe: "/engine/zandronum" },
      { existsSync: () => true, readTextSync: () => "all quiet\n" },
    );
    expect(await h.text("get_startup_errors")).toMatch(/Last lines of the engine log[\s\S]*all quiet/);
  });

  it("reports no crash when there is no crash file", async () => {
    const h = await offline({ exe: "/engine/zandronum" }, { existsSync: () => false });
    expect(await h.text("get_crash")).toMatch(/No crash recorded for instance 1/);
  });

  it("reports no crash when the instance has no log path at all", async () => {
    const h = await offline();
    expect(await h.text("get_crash")).toMatch(/No crash recorded/);
  });

  it("returns the captured backtrace", async () => {
    const h = await offline(
      { exe: "/engine/zandronum" },
      { existsSync: () => true, readTextSync: () => "SIGSEGV at 0x0\n#0 R_DrawColumn" },
    );
    expect(await h.text("get_crash")).toMatch(/SIGSEGV at 0x0/);
  });
});

describe("progress reporting on slow tools", () => {
  it("reports progress while sampling a profiling window", async () => {
    const h = await live({ responses: { acsprofile: ["MOD name 1 2 3 4 5"] } });
    const { result, progress } = await h.callWithProgress("profile_window", { seconds: 30 });
    expect(result.content?.[0]?.text).toBe("1 profiled over 30s");
    expect(progress).toEqual([{ progress: 1000, total: 30000, message: "sampling for 30s" }]);
  });

  it("reports progress while waiting for a launching engine", async () => {
    bridge = await FakeBridge.start();
    harness = await startHarness({
      config: { exe: "/engine/zandronum", basePort: bridge.port },
      io: {
        existsSync: () => true,
        hasBridge: () => true,
        launchIo: {
          spawn: () => ({ pid: undefined, kill: () => {} }),
          waitForPort: () => Promise.resolve(),
          clearQuarantine: () => {},
        },
      },
    });
    const { progress } = await harness.callWithProgress("launch_instance");
    expect(progress[0]).toMatchObject({ total: 42000, message: "waiting for the engine" });
  });

  it("reports progress for stepping, typing, navigating and capturing", async () => {
    const h = await live({ responses: { menu_options: ["opened"] } });
    expect((await h.callWithProgress("step", { tics: 350 })).progress[0]).toMatchObject({
      total: 10000,
      message: "advancing 350 tic(s)",
    });
    expect((await h.callWithProgress("menu_text", { text: "abc" })).progress[0]).toMatchObject({
      total: 120,
      message: "typing",
    });
    expect((await h.callWithProgress("menu_nav", { steps: ["up", "down"] })).progress[0]).toMatchObject({
      total: 120,
      message: "sending menu keys",
    });
    expect((await h.callWithProgress("screenshot")).progress[0]).toMatchObject({
      message: "capturing screenshot",
    });
    expect((await h.callWithProgress("verify_menu", { open: "menu_options" })).progress[0]).toMatchObject({
      message: "opening and capturing menu",
    });
  });

  it("caps the reported progress at the estimate when work overruns it", async () => {
    // Five ticks against a 2s estimate: progress must not climb past the total.
    let ticks = 0;
    const h = await live({
      responses: { acsprofile: [] },
      io: {
        every: (_ms, fn) => {
          for (ticks = 0; ticks < 5; ticks++) fn();
          return () => {};
        },
      },
    });
    const { progress } = await h.callWithProgress("profile_window", { seconds: 2 });
    expect(progress.map((p) => p.progress)).toEqual([1000, 2000, 2000, 2000, 2000]);
  });

  it("keeps working when the client has stopped listening for progress", async () => {
    // A real client/server pair can't make sendNotification reject on demand,
    // so drive the handler directly against a live fake bridge.
    const h = await live({ responses: { acsprofile: ["MOD name 1 2 3 4 5"] } });
    const handlers = collectTools(h.ctx);
    const result = await handlers.get("profile_window")!(
      { instance: 1, seconds: 1 },
      {
        _meta: { progressToken: 7 },
        sendNotification: () => Promise.reject(new Error("client went away")),
      },
    );
    // The failed notification must not take the profiling run down with it.
    expect(result.content?.[0]?.text).toBe("1 profiled over 1s");
  });
});
