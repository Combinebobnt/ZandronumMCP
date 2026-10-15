import { describe, it, expect } from "vitest";
import { collectAcsLumps, collectAcsModules, pickModules } from "../src/acs/collect.js";
import { parseBehaviorNames } from "../src/acs/bytecode.js";
import { buildWad, buildZip } from "./fakes/wad-builder.js";
import { buildBehaviorAcse } from "./fakes/acs-builder.js";

describe("collectAcsLumps", () => {
  it("finds BEHAVIOR lumps in a plain WAD", () => {
    const wad = buildWad("PWAD", [
      { name: "MAP01" },
      { name: "BEHAVIOR", data: buildBehaviorAcse(["wadFunc"], []) },
    ]);
    const lumps = collectAcsLumps(wad);
    expect(lumps).toHaveLength(1);
    expect(parseBehaviorNames(lumps[0]).functions).toEqual(["wadFunc"]);
  });

  it("accepts a raw compiled ACS lump (a .o file) directly", () => {
    const lib = buildBehaviorAcse(["rawFunc"], []);
    const lumps = collectAcsLumps(lib);
    expect(lumps).toHaveLength(1);
    expect(parseBehaviorNames(lumps[0]).functions).toEqual(["rawFunc"]);
  });

  it("finds compiled library lumps and map BEHAVIORs inside a PK3", () => {
    const innerWad = buildWad("PWAD", [
      { name: "MAP01" },
      { name: "BEHAVIOR", data: buildBehaviorAcse(["mapFunc"], []) },
    ]);
    const pk3 = buildZip([
      { name: "decorate.txt", data: Buffer.from("actor X {}") }, // ignored
      { name: "acs/lib.o", data: buildBehaviorAcse(["libFunc"], ["libScript"]), method: 8 },
      { name: "maps/MAP01.wad", data: innerWad },
    ]);
    const lumps = collectAcsLumps(pk3);
    const names = lumps.flatMap((l) => parseBehaviorNames(l).functions);
    expect(names).toContain("libFunc"); // compiled library
    expect(names).toContain("mapFunc"); // map BEHAVIOR inside the inner wad
    expect(lumps).toHaveLength(2);
  });
});

describe("collectAcsModules", () => {
  const lib = buildBehaviorAcse(["f"], []);

  it("names a raw lump by the caller's name, defaulting to BEHAVIOR", () => {
    expect(collectAcsModules(lib, "lib.o").map((m) => m.name)).toEqual(["lib.o"]);
    expect(collectAcsModules(lib).map((m) => m.name)).toEqual(["BEHAVIOR"]);
  });

  it("names map BEHAVIORs by their map marker (binary or UDMF), else BEHAVIOR", () => {
    const wad = buildWad("PWAD", [
      { name: "MAP01" },
      { name: "THINGS" },
      { name: "BEHAVIOR", data: lib },
      { name: "MAP02" },
      { name: "TEXTMAP" },
      { name: "BEHAVIOR", data: lib },
      { name: "ENDMAP" },
    ]);
    expect(collectAcsModules(wad).map((m) => m.name)).toEqual(["MAP01", "MAP02"]);
    const bare = buildWad("PWAD", [{ name: "BEHAVIOR", data: lib }]);
    expect(collectAcsModules(bare).map((m) => m.name)).toEqual(["BEHAVIOR"]);
  });

  it("prefixes a pk3's map BEHAVIORs with the wad entry and names libraries by entry", () => {
    const inner = buildWad("PWAD", [{ name: "MAP01" }, { name: "THINGS" }, { name: "BEHAVIOR", data: lib }]);
    const pk3 = buildZip([
      { name: "acs/lib.o", data: lib },
      { name: "maps/MAP01.wad", data: inner },
    ]);
    expect(collectAcsModules(pk3).map((m) => m.name)).toEqual(["acs/lib.o", "maps/MAP01.wad:MAP01"]);
  });
});

describe("pickModules", () => {
  const modules = ["acs/MyMod.o", "maps/MAP01.wad:MAP01"].map((name) => ({ name, data: Buffer.alloc(0) }));
  const names = (lump?: string) => pickModules(modules, lump).map((m) => m.name);

  it("keeps every module without a lump", () => {
    expect(names()).toHaveLength(2);
  });

  it("matches a full name or an extension-less basename, case-insensitively", () => {
    expect(names("mymod")).toEqual(["acs/MyMod.o"]);
    expect(names("ACS/MYMOD.O")).toEqual(["acs/MyMod.o"]);
    expect(names("maps/map01.wad:map01")).toEqual(["maps/MAP01.wad:MAP01"]);
    expect(names("other")).toEqual([]);
  });
});
