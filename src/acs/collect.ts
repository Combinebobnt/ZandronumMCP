import { parseWad } from "../map/wad.js";
import { isZip, listZipEntries, readZipEntry } from "../map/zip.js";

// ACS bytecode magics: "ACS\0", "ACSE", "ACSe".
const ACS_MAGICS = new Set([0x00534341, 0x45534341, 0x65534341]);

function looksLikeAcs(buf: Buffer): boolean {
  return buf.length >= 4 && ACS_MAGICS.has(buf.readUInt32LE(0));
}

export interface AcsModule {
  /** Zip entry name, `<wad>:<map marker>` for a map BEHAVIOR, or the caller's raw-file name. */
  name: string;
  data: Buffer;
}

// A map's marker is the lump right before its THINGS (binary) or TEXTMAP (UDMF).
const MAP_FIRST_LUMPS = new Set(["THINGS", "TEXTMAP"]);

function behaviorModules(wadBuf: Buffer, prefix: string): AcsModule[] {
  const lumps = parseWad(wadBuf).lumps;
  const out: AcsModule[] = [];
  let marker = "BEHAVIOR";
  lumps.forEach((l, i) => {
    if (MAP_FIRST_LUMPS.has(lumps[i + 1]?.name ?? ""))marker = l.name;
    if (l.name === "BEHAVIOR" && l.size > 0) {
      out.push({ name: prefix + marker, data: wadBuf.subarray(l.offset, l.offset + l.size) });
    }
  });
  return out;
}

/**
 * Collect every compiled ACS bytecode lump in a WAD or PK3, with a name for each:
 * compiled `#library` lumps (a zip entry that is itself ACS bytecode) plus the
 * BEHAVIOR lump of each contained map WAD. This is what lets bytecode reading
 * work on a source-less mod, where the scripts live in a compiled library.
 */
export function collectAcsModules(buffer: Buffer, rawName = "BEHAVIOR"): AcsModule[] {
  if (looksLikeAcs(buffer)) return [{ name: rawName, data: buffer }]; // a raw compiled .o / BEHAVIOR file
  if (!isZip(buffer)) return behaviorModules(buffer, "");
  const out: AcsModule[] = [];
  for (const entry of listZipEntries(buffer)) {
    const data = readZipEntry(buffer, entry);
    if (looksLikeAcs(data)) out.push({ name: entry.name, data });
    else if (entry.name.toLowerCase().endsWith(".wad")) out.push(...behaviorModules(data, `${entry.name}:`));
  }
  return out;
}

/** Just the bytecode buffers of `collectAcsModules`, for callers that pool names across modules. */
export function collectAcsLumps(buffer: Buffer): Buffer[] {
  return collectAcsModules(buffer).map((m) => m.data);
}
