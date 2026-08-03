import path from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { InstanceRegistry, defaultLaunchIo, type LaunchIo } from "./process/registry.js";
import { findFreePort } from "./process/launch.js";
import { reapOrphanEngines, defaultIo as defaultReapIo, type ReapResult, type ReapOptions } from "./process/reap.js";
import { hasBridge } from "./process/verify.js";
import { buildIndex, type AcsIndex } from "./acs/symbols.js";
import { readMapFromContainer, type MapData } from "./map/index.js";
import { captureScreenshot } from "./screenshot/capture.js";
import type { BridgeClient } from "./bridge/transport.js";

/** Everything the tools need from the environment, resolved once at startup. */
export interface ServerConfig {
  host: string;
  basePort: number;
  /** Path to the bridge-patched engine binary, if one is configured. */
  exe?: string;
  screenshotDir: string;
  iwad?: string;
  acsSrc?: string;
  saveDir?: string;
}

/**
 * Side-effecting I/O the tools do, behind one injectable seam so every tool
 * branch is testable without a real engine, real clock, or real files.
 */
export interface ContextIo {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string) => Buffer;
  readTextSync: (p: string) => string;
  readdirSync: (p: string) => string[];
  /** Change-detection stamp for a file; used to invalidate parse caches. */
  stampOf: (p: string) => string;
  sleep: (ms: number) => Promise<void>;
  /** Run `fn` every `ms` until the returned cancel is called. */
  every: (ms: number, fn: () => void) => () => void;
  capture: (client: BridgeClient, dir: string) => Promise<{ base64: string }>;
  findFreePort: (start: number) => Promise<number>;
  hasBridge: (exe: string) => boolean;
  reap: (exe: string, opts?: ReapOptions) => Promise<ReapResult>;
  launchIo: LaunchIo;
}

export const defaultContextIo: ContextIo = {
  existsSync: (p) => existsSync(p),
  readFileSync: (p) => readFileSync(p),
  readTextSync: (p) => readFileSync(p, "utf8"),
  readdirSync: (p) => readdirSync(p),
  stampOf: (p) => {
    const s = statSync(p);
    return `${s.mtimeMs}:${s.size}`;
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  every: (ms, fn) => {
    const timer = setInterval(fn, ms);
    // Never let a progress ticker hold the process open.
    timer.unref?.();
    return () => clearInterval(timer);
  },
  capture: (client, dir) => captureScreenshot(client, { dir }),
  findFreePort: (start) => findFreePort(start),
  hasBridge: (exe) => hasBridge(exe),
  reap: (exe, opts) => reapOrphanEngines(exe, defaultReapIo, opts),
  launchIo: defaultLaunchIo,
};

/**
 * Shared state and helpers for the tool layer: which port each instance is on,
 * the bridge connections, and the parse caches for WADs and ACS source.
 *
 * Split out of the tool definitions so the tools stay declarative and this —
 * the part with the caching, port and attach logic worth testing — is a plain
 * object with injected I/O.
 */
export class ServerContext {
  /** Ports actually chosen at launch. `launch_instance` picks the first FREE
   *  port at or above the conventional one, so a stale process squatting the
   *  default can't cause a silent mis-attach. */
  private readonly launchedPorts = new Map<number, number>();
  /** Per-instance engine console logfile (ZANDRONUM_BRIDGE_LOG). */
  private readonly logFiles = new Map<number, string>();
  /** In-flight attaches, keyed by instance — see `clientFor`. */
  private readonly attaching = new Map<number, Promise<BridgeClient>>();
  /** PID of the engine each instance was launched as, when the bridge reported
   *  one. Used to catch a re-attach landing on a different process. */
  private readonly enginePids = new Map<number, number>();
  private readonly maps = new Map<string, { stamp: string; data: MapData }>();
  private readonly acsIndexes = new Map<string, { stamp: string; index: AcsIndex }>();

  constructor(
    readonly config: ServerConfig,
    readonly io: ContextIo = defaultContextIo,
    readonly registry: InstanceRegistry = new InstanceRegistry(),
  ) {}

  /** The conventional port for an instance: instance 1 gets the base port. */
  portFor(instance: number): number {
    return this.config.basePort + (instance - 1);
  }

  /** The port an instance is actually on — what launch picked, else conventional. */
  effectivePort(instance: number): number {
    return this.launchedPorts.get(instance) ?? this.portFor(instance);
  }

  rememberLaunch(instance: number, port: number, logFile: string): void {
    this.launchedPorts.set(instance, port);
    this.logFiles.set(instance, logFile);
  }

  /** Record which process an instance's bridge belongs to, once it says so. */
  rememberEngine(instance: number, pid: number | undefined): void {
    if (pid !== undefined) this.enginePids.set(instance, pid);
  }

  forgetInstance(instance: number): void {
    this.launchedPorts.delete(instance);
    this.logFiles.delete(instance);
    this.enginePids.delete(instance);
  }

  forgetAll(): void {
    this.launchedPorts.clear();
    this.logFiles.clear();
    this.enginePids.clear();
  }

  /** Where an instance's engine console log lives, if it can be determined. */
  logPathFor(instance: number): string | undefined {
    const known = this.logFiles.get(instance);
    if (known) return known;
    return this.config.exe
      ? path.join(path.dirname(this.config.exe), `mcp-bridge-${this.effectivePort(instance)}.log`)
      : undefined;
  }

  /**
   * Lazily attach to instance N on first use.
   *
   * Concurrent callers share one attach: MCP clients issue tool calls in
   * parallel, and without this each would see "not attached", open its own
   * socket, and all but the last would be orphaned in the registry — leaked
   * connections plus a bridge talking to a client nobody holds.
   *
   * A re-attach also re-checks identity. `launch_instance` verifies the bridge
   * it connected to is the process it spawned, but that guarantee expires the
   * moment the connection drops: if the engine dies and anything else takes its
   * port, the next tool call would silently drive the wrong process. So when we
   * know which PID an instance is supposed to be, a mismatch fails loudly
   * instead.
   */
  async clientFor(instance: number): Promise<BridgeClient> {
    if (this.registry.has(instance)) return this.registry.get(instance);
    const inflight = this.attaching.get(instance);
    if (inflight) return inflight;
    const port = this.effectivePort(instance);
    const attach = this.registry
      .attach({ id: instance, host: this.config.host, port })
      .then((client) => {
        const expected = this.enginePids.get(instance);
        const actual = client.enginePid;
        // Only enforced when both sides report a PID — older bridges omit it.
        if (expected !== undefined && actual !== undefined && actual !== expected) {
          this.registry.detach(instance);
          throw new Error(
            `Bridge on ${this.config.host}:${port} is PID ${actual}, not the engine ` +
              `launched for instance ${instance} (PID ${expected}) — the original engine ` +
              `is gone and something else took its port. Run the "reset" tool, then relaunch.`,
          );
        }
        return client;
      })
      .finally(() => this.attaching.delete(instance));
    this.attaching.set(instance, attach);
    return attach;
  }

  /**
   * Read a map from a WAD/PK3, memoised so a slaughtermap is parsed once and
   * then sliced per query.
   *
   * Keyed on the container's mtime+size, not just its path: the whole point of
   * this server is an agent editing a WAD and re-inspecting it, and a
   * path-keyed cache would keep serving the pre-edit geometry forever. A
   * changed stamp replaces the entry, so the cache also can't grow without
   * bound for a file being edited in a loop.
   */
  loadMap(file: string | undefined, map: string): MapData {
    const wad = file ?? this.config.iwad;
    if (!wad) throw new Error("No WAD specified. Pass `file` or set ZANDRONUM_IWAD.");
    const key = `${wad}|${map.toUpperCase()}`;
    const stamp = this.io.stampOf(wad);
    const hit = this.maps.get(key);
    if (hit && hit.stamp === stamp) return hit.data;
    const data = readMapFromContainer(this.io.readFileSync(wad), map);
    this.maps.set(key, { stamp, data });
    return data;
  }

  /**
   * Index a directory of .acs sources, memoised on the stamps of the files
   * themselves. A directory's own mtime doesn't move when a file's contents
   * change, so the stamp covers every .acs file in it — otherwise an agent that
   * edits a script keeps resolving symbols against the version it started with.
   */
  loadAcsIndex(dir: string | undefined): AcsIndex {
    const src = dir ?? this.config.acsSrc;
    if (!src) throw new Error("No ACS source dir. Pass `dir` or set ZANDRONUM_ACS_SRC.");
    const names = this.io
      .readdirSync(src)
      .filter((f) => f.toLowerCase().endsWith(".acs"))
      .sort();
    const stamp = names.map((n) => `${n}@${this.io.stampOf(path.join(src, n))}`).join("|");
    const hit = this.acsIndexes.get(src);
    if (hit && hit.stamp === stamp) return hit.index;
    const files = names.map((f) => ({ path: f, text: this.io.readTextSync(path.join(src, f)) }));
    const index = buildIndex(files);
    this.acsIndexes.set(src, { stamp, index });
    return index;
  }

  /** Where savegames live: explicit arg, then env, then next to the engine. */
  resolveSaveDir(dir?: string): string {
    const d = dir ?? this.config.saveDir ?? (this.config.exe ? path.dirname(this.config.exe) : undefined);
    if (!d) throw new Error("No save dir. Pass `dir`, or set ZANDRONUM_SAVE_DIR or ZANDRONUM_EXE.");
    return d;
  }
}
