// Read function and named-script names out of a compiled ACS BEHAVIOR lump, for
// mods that ship bytecode but no source. Ports the engine's chunk logic
// (FBehavior load + FindChunk, p_acs.cpp): FNAM = function names, SNAM = named
// scripts. Numbered scripts have no names in bytecode (their source #define
// aliases are compiled away) — only the source indexer can recover those.

const MAGIC_ACS0 = 0x00534341; // "ACS\0"
const MAGIC_ACSE = 0x45534341; // "ACSE"
const MAGIC_ACSe = 0x65534341; // "ACSe"
const ID_FNAM = 0x4d414e46; // "FNAM"
const ID_SNAM = 0x4d414e53; // "SNAM"
const ID_MEXP = 0x5058454d; // "MEXP"
const ID_ARAY = 0x59415241; // "ARAY"

export interface BytecodeNames {
  functions: string[];
  namedScripts: string[];
}

/** Where the chunk region lives + how far it runs. null if not chunked bytecode. */
function locateChunks(lump: Buffer): { offset: number; end: number } | null {
  if (lump.length < 8) return null;
  const magic = lump.readUInt32LE(0);
  if (magic === MAGIC_ACSE || magic === MAGIC_ACSe) {
    return { offset: lump.readUInt32LE(4), end: lump.length };
  }
  if (magic === MAGIC_ACS0) {
    // Old header may embed enhanced chunks: two DWORDs sit just before the
    // directory — [chunks offset][pretag]. (p_acs.cpp:2407-2419)
    const dirofs = lump.readUInt32LE(4);
    if (dirofs >= 24 && dirofs <= lump.length) {
      const pretag = lump.readUInt32LE(dirofs - 4);
      if (pretag === MAGIC_ACSE || pretag === MAGIC_ACSe) {
        return { offset: lump.readUInt32LE(dirofs - 8), end: dirofs - 8 };
      }
    }
  }
  return null;
}

/** Walk the chunk list ([id][size][data]) for a chunk id; -1 if absent. */
function findChunk(lump: Buffer, region: { offset: number; end: number }, id: number): number {
  let o = region.offset;
  while (o + 8 <= region.end) {
    if (lump.readUInt32LE(o) === id) return o;
    o += lump.readUInt32LE(o + 4) + 8;
  }
  return -1;
}

/** A name chunk: [count][offset×count][nul-terminated strings], offsets relative to chunk+8. */
function readNameChunk(lump: Buffer, chunkStart: number): string[] {
  const base = chunkStart + 8;
  const count = lump.readUInt32LE(base);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const start = base + lump.readUInt32LE(base + 4 + i * 4);
    let end = start;
    while (end < lump.length && lump[end] !== 0) end++;
    names.push(lump.toString("latin1", start, end));
  }
  return names;
}

/** Extract function + named-script names from a BEHAVIOR lump buffer. */
export function parseBehaviorNames(lump: Buffer): BytecodeNames {
  const region = locateChunks(lump);
  if (!region) return { functions: [], namedScripts: [] };
  const fnam = findChunk(lump, region, ID_FNAM);
  const snam = findChunk(lump, region, ID_SNAM);
  return {
    functions: fnam >= 0 ? readNameChunk(lump, fnam) : [],
    namedScripts: snam >= 0 ? readNameChunk(lump, snam) : [],
  };
}

export interface MapExport {
  name: string;
  /** Map variable slot; MEXP entry i names slot i (FindMapVarName, p_acs.cpp). */
  index: number;
  isArray: boolean;
  /** Element count, for arrays only. */
  size?: number;
}

/**
 * Exported map variables and arrays: the only names get_map_var/get_map_array can
 * see. MEXP is a name chunk; ARAY is [slot][size] pairs (p_acs.cpp, "Create arrays").
 */
export function parseMapExports(lump: Buffer): MapExport[] {
  const region = locateChunks(lump);
  if (!region) return [];
  const mexp = findChunk(lump, region, ID_MEXP);
  if (mexp < 0) return [];
  const sizes = new Map<number, number>();
  const aray = findChunk(lump, region, ID_ARAY);
  if (aray >= 0) {
    // A corrupt size can't read past the lump (readUInt32LE throws there).
    const count = Math.floor(Math.min(lump.readUInt32LE(aray + 4), lump.length - aray - 8) / 8);
    for (let i = 0; i < count; i++) {
      sizes.set(lump.readUInt32LE(aray + 8 + i * 8), lump.readUInt32LE(aray + 12 + i * 8));
    }
  }
  return readNameChunk(lump, mexp).flatMap((name, index) => {
    if (!name) return [];
    const size = sizes.get(index);
    return [size === undefined ? { name, index, isArray: false } : { name, index, isArray: true, size }];
  });
}
