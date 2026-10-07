import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { z } from "zod";
import path from "node:path";
import type { ServerContext } from "./context.js";
import { parseStartupErrors, tailLines, crashLogPath, readLogWindow } from "./process/startuplog.js";
import { parseDumpActors } from "./parsers/dumpactors.js";
import { parseScriptStat } from "./parsers/scriptstat.js";
import { parseAcsVars } from "./parsers/acsvars.js";
import { parseMapVar, parseMapArray, parseModules } from "./parsers/mapvars.js";
import { parseScripts, parseFunctions } from "./parsers/scripts.js";
import { parseAcsProfile } from "./parsers/acsprofile.js";
import { cleanConsoleLines } from "./parsers/consoletext.js";
import { parsePlayerState, parseTarget, withLiveStatus } from "./parsers/playerstate.js";
import { pollUntil } from "./poll.js";
import { parseActorState, parseActorsNear, parseFindActors } from "./parsers/actorstate.js";
import { parsePlayers } from "./parsers/players.js";
import { parseKvLines, firstError, hasHeader, failureText } from "./parsers/lines.js";
import { parseHud } from "./parsers/hud.js";
import { describeStatus } from "./parsers/status.js";
import type { BridgeClient } from "./bridge/transport.js";
import { findSymbol } from "./acs/symbols.js";
import { collectAcsLumps, collectAcsModules } from "./acs/collect.js";
import { parseBehaviorNames, parseMapExports } from "./acs/bytecode.js";
import { parseRenderInfo, pick } from "./parsers/renderinfo.js";
import { command, kvArgs, buildPuke, buildPukeName, buildSave } from "./commands/builders.js";
import { readSaveMeta } from "./saves/png.js";
import {
  menuKeyEvent,
  menuKeyUpEvent,
  charEvent,
  mouseMoveEvent,
  mouseButtonEvent,
  wheelEvent,
  type MenuKey,
} from "./input/keys.js";

const instanceArg = z.number().int().positive().default(1);
const acsScope = z.enum(["world", "global"]);
const acsSrcArg = z.string().optional();
const acsName = z.string().min(1);
const mapFileArg = z.string().optional();
const className = z.string().regex(/^\S+$/, "a class name has no spaces");

/** `set_cheat` names: each is its own stock toggle CCMD, keyed to its `CF_*` bit (d_player.h). */
const CHEATS = {
  noclip: 1 << 0,
  god: 1 << 1,
  notarget: 1 << 3,
  fly: 1 << 4,
  buddha: 1 << 27,
  noclip2: 1 << 30,
} as const;
const CHEAT_NAMES = Object.keys(CHEATS) as [keyof typeof CHEATS, ...(keyof typeof CHEATS)[]];
// A queued cheat lands on the next tic; about 2s of polling covers a busy frame.
const CHEAT_POLLS = 20;
const CHEAT_POLL_MS = 100;

const MENU_KEYS = ["up", "down", "left", "right", "enter", "back", "backspace"] as const;

const profileSort = z.enum(["total", "avg", "min", "max", "runs"]).optional();
const profileLimit = z.number().int().positive().optional();

/** `acsprofile` with its optional sort key and row limit. Shared by the
 *  cumulative and windowed profiling tools so the arg shaping lives in one place. */
function profileCommand(sort?: string, limit?: number): string {
  if (!sort) return "acsprofile";
  return command("acsprofile", sort, ...(limit !== undefined ? [limit] : []));
}

/** The isError result for a CCMD that gave no usable reply (see `failureText`). */
function failed(output: string[]) {
  return { isError: true, content: [{ type: "text" as const, text: failureText(output) }] };
}

/**
 * How often a slow tool reports that it's still working.
 *
 * Several tools legitimately block for a long time — `profile_window` samples
 * for up to 30s, `launch_instance` waits up to ~42s for the engine to open its
 * bridge, `screenshot` can wait ~19s on a busy frame. MCP clients apply their
 * own request timeout (often 10s) and would give up on all of these. A client
 * that resets its timeout on progress won't, so heartbeat while we wait.
 */
const PROGRESS_INTERVAL_MS = 1000;

/** The slice of the SDK's handler `extra` that progress reporting needs. */
interface ToolExtra {
  _meta?: { progressToken?: string | number };
  sendNotification: (n: {
    method: "notifications/progress";
    params: {
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    };
  }) => Promise<void>;
}

// The TICRATE (35 tics/sec) is fixed in Doom.
const TICRATE = 35;
const NO_TIME_CAP =
  "This engine bridge has no time-control support (rebuild/redownload with the latest bridge).";
const NO_INPUT_CAP =
  "This engine bridge has no input support (rebuild with the latest bridge).";

// A load tool polls status until its queued load runs: about 5 s in all.
const LOAD_READ_MS = 500;
const LOAD_WAIT_MS = 50;
const LOAD_WAITS = 9;
// About 2 tics: posted input events are processed on the next tic, not on receipt.
const INPUT_SETTLE_MS = 60;

/** Register every MCP tool against a context. */
export function registerTools(server: McpServer, ctx: ServerContext): void {
  const sleep = (ms: number) => ctx.io.sleep(ms);

  /**
   * Run `work`, reporting progress while it goes. `expectedMs` is only the
   * denominator for the progress ratio — overrunning it is fine, the count just
   * stops climbing. A no-op when the client didn't ask for progress (no token).
   */
  async function withProgress<T>(
    extra: ToolExtra,
    expectedMs: number,
    message: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const progressToken = extra._meta?.progressToken;
    if (progressToken === undefined) return work();
    let elapsed = 0;
    const stop = ctx.io.every(PROGRESS_INTERVAL_MS, () => {
      elapsed += PROGRESS_INTERVAL_MS;
      // Fire-and-forget: a client that has stopped listening must not break the
      // work we're actually here to do.
      void extra
        .sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress: Math.min(elapsed, expectedMs),
            total: expectedMs,
            message,
          },
        })
        .catch(() => {});
    });
    try {
      return await work();
    } finally {
      stop();
    }
  }

  /**
   * Register a tool that talks to a live engine, so its response carries a
   * short "engine state" note whenever something about the game is unusual
   * (paused, in a menu, dead, at intermission, ...). Silence means normal, so
   * a healthy round trip costs nothing to read — see `parsers/status.ts`.
   *
   * The `commandCount` diff decides whether to refresh: if it didn't move
   * across the handler call, the handler ran no console command (an
   * input-only tool, or a client that didn't exist until the handler created
   * it — `attach_instance`/`launch_instance`), so the cached status predates
   * whatever the handler just did. If it DID move, the handler's own command
   * already refreshed it via that command's own sentinel line, so refreshing
   * again would just be a second wasted round trip. This subsumes a
   * hand-maintained list of "tools that run a command", which would get cases
   * like `verify_menu` (runs a command only when `open` is given) wrong.
   *
   * Two invariants the wrapper must not violate:
   * - It only ever PEEKS the registry (`ctx.attachedClient`), never
   *   `ctx.clientFor` — so it can never itself open a socket or turn a
   *   successful call into a failure.
   * - It does not try/catch the handler: a thrown error (unbound instance, a
   *   `loadMap` failure) must propagate byte-identically to a plain
   *   `server.registerTool` call.
   */
  function registerLive<Input extends ZodRawShapeCompat & { instance: typeof instanceArg }>(
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema: Input;
      outputSchema?: ZodRawShapeCompat;
    },
    handler: ToolCallback<Input>,
  ): void {
    // TS can't carry an abstract `Input` through the SDK's own generic
    // machinery inside this function body (a known limitation of generic
    // functions built on other generics) — so the args/extra/result shapes
    // are pinned to a concrete instantiation here and the two boundaries
    // (calling `handler`, registering `wrapped`) are cast back to `Input`.
    // Every *call site* of `registerLive` still gets full inference, because
    // there `Input` is concrete, not abstract.
    type Args = { instance: number } & Record<string, unknown>;
    type Extra = Parameters<ToolCallback<{ instance: typeof instanceArg }>>[1];
    type Result = Awaited<ReturnType<ToolCallback<{ instance: typeof instanceArg }>>>;
    const rawHandler = handler as unknown as (args: Args, extra: Extra) => Promise<Result>;

    const wrapped = async (args: Args, extra: Extra): Promise<Result> => {
      const instance = args.instance;
      const prior = ctx.attachedClient(instance);
      const before = prior?.commandCount;
      const eventsBefore = prior?.eventCount ?? 0;
      const result = await rawHandler(args, extra);
      const client = ctx.attachedClient(instance);
      const advanced = before !== undefined && client !== undefined && client.commandCount > before;
      if (client && !advanced) {
        // Posted events run on a later tic, so a same-instant read would predate them.
        if (client.eventCount > eventsBefore) await sleep(INPUT_SETTLE_MS);
        await client.refreshStatus();
      }
      const status = client?.lastStatus;
      const note = status ? describeStatus(status) : undefined;
      if (!note) return result;
      return { ...result, content: [...result.content, { type: "text", text: note }] };
    };
    server.registerTool(name, config, wrapped as unknown as ToolCallback<Input>);
  }

  /**
   * Run `map`/`load`/`playdemo`, which only queue a load for the next tic (so the
   * command's own status line predates it), then poll status until `pending=0`.
   * Returns the output plus what the engine printed meanwhile, e.g. a load error.
   */
  async function runLoad(client: BridgeClient, cmd: string): Promise<string[]> {
    const out = await client.runCommand(cmd);
    if (!client.supports("status")) return cleanConsoleLines(out);
    const printed: string[] = [];
    // A snapshot with no pending= field (an older overlay) counts as settled.
    const read = async () => {
      const got = await client.readStatus(LOAD_READ_MS);
      printed.push(...got.lines);
      return got.status !== undefined && got.status.pending !== "1";
    };
    const { value: settled } = await pollUntil(read, (s) => s, {
      waits: LOAD_WAITS,
      wait: () => sleep(LOAD_WAIT_MS),
    });
    const caveat = settled ? [] : ["(load still pending after ~5 s; the engine-state note may predate it)"];
    return [...cleanConsoleLines([...out, ...printed]), ...caveat];
  }

  function postMenuKey(
    client: { sendEvent: (a: number, b: number, c: number, d: number) => void },
    key: MenuKey,
  ) {
    const down = menuKeyEvent(key);
    client.sendEvent(down.evtype, down.subtype, down.data1, down.data2);

    // The RELEASE, which used to be missing. M_Responder latches a key into MenuButtons[] on the way
    // down and unlatches it on the way up, and M_Ticker repeats whatever is still latched -- so a
    // single unreleased "down" walked the selection down the whole list and kept going. Without this
    // the caller is testing an auto-repeat, not a keypress.
    const up = menuKeyUpEvent(key);
    client.sendEvent(up.evtype, up.subtype, up.data1, up.data2);
  }

  // --- commands, cheats & input ---------------------------------------------
  registerLive(
    "run_command",
    {
      title: "Run console command",
      description:
        "Send a raw console command to a running, bridge-patched Zandronum instance and return its captured output.",
      inputSchema: { instance: instanceArg, text: z.string().min(1) },
    },
    async ({ instance, text }) => {
      const client = await ctx.clientFor(instance);
      const output = await client.runCommand(text);
      return { content: [{ type: "text", text: output.join("\n") || "(no output)" }] };
    },
  );

  registerLive(
    "list_actor_classes",
    {
      title: "List actor classes",
      description:
        "Run `dumpactors` and return the registered DECORATE/actor classes as structured data.",
      inputSchema: { instance: instanceArg },
      outputSchema: {
        actors: z.array(
          z.object({
            name: z.string(),
            edNum: z.number(),
            spawnId: z.number(),
            filter: z.string(),
            source: z.string(),
          }),
        ),
      },
    },
    async ({ instance }) => {
      const client = await ctx.clientFor(instance);
      const output = await client.runCommand("dumpactors");
      const actors = parseDumpActors(output);
      return {
        content: [{ type: "text", text: `${actors.length} actor classes` }],
        structuredContent: { actors },
      };
    },
  );

  registerLive(
    "summon",
    {
      title: "Summon actor",
      description: "Spawn an actor of the given class at the player's position.",
      inputSchema: {
        instance: instanceArg,
        className: z.string().min(1),
        kind: z.enum(["normal", "friend", "foe"]).default("normal"),
      },
    },
    async ({ instance, className, kind }) => {
      const verb = kind === "friend" ? "summonfriend" : kind === "foe" ? "summonfoe" : "summon";
      const client = await ctx.clientFor(instance);
      const output = await client.runCommand(command(verb, className));
      return { content: [{ type: "text", text: output.join("\n") || `summoned ${className}` }] };
    },
  );

  registerLive(
    "give",
    {
      title: "Give item",
      description: "Give an inventory item to the player.",
      inputSchema: {
        instance: instanceArg,
        item: z.string().min(1),
        amount: z.number().int().positive().optional(),
      },
    },
    async ({ instance, item, amount }) => {
      const client = await ctx.clientFor(instance);
      const cmd = amount === undefined ? command("give", item) : command("give", item, amount);
      const output = await client.runCommand(cmd);
      return { content: [{ type: "text", text: output.join("\n") || `gave ${item}` }] };
    },
  );

  registerLive(
    "take",
    {
      title: "Take item",
      description: "Remove an inventory item from the player.",
      inputSchema: {
        instance: instanceArg,
        item: z.string().min(1),
        amount: z.number().int().positive().optional(),
      },
    },
    async ({ instance, item, amount }) => {
      const client = await ctx.clientFor(instance);
      const cmd = amount === undefined ? command("take", item) : command("take", item, amount);
      const output = await client.runCommand(cmd);
      return { content: [{ type: "text", text: output.join("\n") || `took ${item}` }] };
    },
  );

  registerLive(
    "load_map",
    {
      title: "Load map",
      description: "Load a map by its lump name (e.g. MAP01, E1M1).",
      inputSchema: { instance: instanceArg, mapName: z.string().min(1) },
    },
    async ({ instance, mapName }) => {
      const client = await ctx.clientFor(instance);
      const output = await runLoad(client, command("map", mapName));
      return { content: [{ type: "text", text: output.join("\n") || `loaded ${mapName}` }] };
    },
  );

  registerLive(
    "list_running_scripts",
    {
      title: "List running ACS scripts",
      description:
        "Run `scriptstat` and return the currently running ACS scripts and their states.",
      inputSchema: { instance: instanceArg },
      outputSchema: {
        scripts: z.array(
          z.object({
            number: z.number().nullable(),
            name: z.string().nullable(),
            state: z.string(),
          }),
        ),
      },
    },
    async ({ instance }) => {
      const client = await ctx.clientFor(instance);
      const output = await client.runCommand("scriptstat");
      const scripts = parseScriptStat(output);
      return {
        content: [{ type: "text", text: `${scripts.length} running script(s)` }],
        structuredContent: { scripts },
      };
    },
  );

  registerLive(
    "run_script",
    {
      title: "Run ACS script",
      description: "Run (puke) an ACS script by number or name, with optional integer arguments.",
      inputSchema: {
        instance: instanceArg,
        script: z.union([z.number().int(), z.string().min(1)]),
        args: z.array(z.number().int()).optional(),
        always: z.boolean().optional(),
      },
    },
    async ({ instance, script, args, always }) => {
      const client = await ctx.clientFor(instance);
      const cmd =
        typeof script === "number" ? buildPuke(script, args) : buildPukeName(script, args, always);
      const output = await client.runCommand(cmd);
      return { content: [{ type: "text", text: output.join("\n") || `ran ${script}` }] };
    },
  );

  registerLive(
    "screenshot",
    {
      title: "Screenshot",
      description: "Take a screenshot of the game and return it as an image so it can be viewed.",
      inputSchema: { instance: instanceArg },
    },
    async ({ instance }, extra) => {
      const client = await ctx.clientFor(instance);
      const shot = await withProgress(extra, 19000, "capturing screenshot", () =>
        ctx.io.capture(client, ctx.config.screenshotDir),
      );
      return { content: [{ type: "image", data: shot.base64, mimeType: "image/png" }] };
    },
  );

  registerLive(
    "screenshot_file",
    {
      title: "Screenshot to a file",
      description:
        "Take a screenshot and leave it on disk, returning only its absolute path (no image content). For measuring pixels with a script instead of viewing the frame. A reused `name` overwrites that file.",
      inputSchema: {
        instance: instanceArg,
        // No spaces or `;`: the name goes unquoted into a console command line.
        name: z
          .string()
          .regex(/^[\w-]+$/, "letters, digits, _ and - only (no extension)")
          .optional(),
      },
    },
    async ({ instance, name }, extra) => {
      const client = await ctx.clientFor(instance);
      const shot = await withProgress(extra, 19000, "capturing screenshot", () =>
        ctx.io.capture(client, ctx.config.screenshotDir, { name, keep: true }),
      );
      const file = path.resolve(shot.path);
      return { content: [{ type: "text", text: file }], structuredContent: { path: file } };
    },
  );

  registerLive(
    "menu_key",
    {
      title: "Press a menu key",
      description: "Send a single menu navigation key (GUI key event) to the active menu.",
      inputSchema: { instance: instanceArg, key: z.enum(MENU_KEYS) },
    },
    async ({ instance, key }) => {
      const client = await ctx.clientFor(instance);
      if (!client.supports("event")) {
        return { isError: true, content: [{ type: "text", text: NO_INPUT_CAP }] };
      }
      postMenuKey(client, key);
      return { content: [{ type: "text", text: `sent ${key}` }] };
    },
  );

  registerLive(
    "menu_nav",
    {
      title: "Navigate a menu",
      description:
        'Send a sequence of menu keys (e.g. ["down","down","enter"]) with a small delay between each.',
      inputSchema: { instance: instanceArg, steps: z.array(z.enum(MENU_KEYS)).min(1) },
    },
    async ({ instance, steps }, extra) => {
      const client = await ctx.clientFor(instance);
      if (!client.supports("event")) {
        return { isError: true, content: [{ type: "text", text: NO_INPUT_CAP }] };
      }
      await withProgress(extra, steps.length * 60, "sending menu keys", async () => {
        for (const key of steps) {
          postMenuKey(client, key);
          await sleep(60);
        }
      });
      return {
        content: [{ type: "text", text: `sent ${steps.length} key(s): ${steps.join(" ")}` }],
      };
    },
  );

  registerLive(
    "menu_text",
    {
      title: "Type into a menu text field",
      description:
        "Type a string into the active menu text-entry field (e.g. the player name box after pressing enter on it), one character at a time.",
      inputSchema: { instance: instanceArg, text: z.string().min(1) },
    },
    async ({ instance, text }, extra) => {
      const client = await ctx.clientFor(instance);
      if (!client.supports("event")) {
        return { isError: true, content: [{ type: "text", text: NO_INPUT_CAP }] };
      }
      await withProgress(extra, text.length * 40, "typing", async () => {
        for (const ch of text) {
          const ev = charEvent(ch);
          client.sendEvent(ev.evtype, ev.subtype, ev.data1, ev.data2);
          await sleep(40);
        }
      });
      return { content: [{ type: "text", text: `typed "${text}"` }] };
    },
  );

  registerLive(
    "mouse_move",
    {
      title: "Move the mouse pointer",
      description:
        "Move the pointer to a screen position, in pixels from the top-left of the game window. Drives hover-only UI -- tooltips, hot states -- which nothing else here can reach.",
      inputSchema: { instance: instanceArg, x: z.number().int(), y: z.number().int() },
    },
    async ({ instance, x, y }) => {
      const client = await ctx.clientFor(instance);
      if (!client.supports("event")) {
        return { isError: true, content: [{ type: "text", text: NO_INPUT_CAP }] };
      }
      const ev = mouseMoveEvent(x, y);
      client.sendEvent(ev.evtype, ev.subtype, ev.data1, ev.data2);
      return { content: [{ type: "text", text: `pointer at ${x},${y}` }] };
    },
  );

  registerLive(
    "mouse_click",
    {
      title: "Click or drag the mouse",
      description:
        "Press and release the left button at a position. Give toX/toY to DRAG: press at the first point, move through it, release at the second. `double` sends a double-click.",
      inputSchema: {
        instance: instanceArg,
        x: z.number().int(),
        y: z.number().int(),
        toX: z.number().int().optional(),
        toY: z.number().int().optional(),
        double: z.boolean().optional(),
      },
    },
    async ({ instance, x, y, toX, toY, double }) => {
      const client = await ctx.clientFor(instance);
      if (!client.supports("event")) {
        return { isError: true, content: [{ type: "text", text: NO_INPUT_CAP }] };
      }
      const post = (e: { evtype: number; subtype: number; data1: number; data2: number }) =>
        client.sendEvent(e.evtype, e.subtype, e.data1, e.data2);

      // Move first: menus track the pointer from motion, so a click at a position they have never
      // seen the pointer at lands on whatever was hovered last.
      post(mouseMoveEvent(x, y));
      await sleep(20);
      post(mouseButtonEvent(x, y, true, double === true));
      await sleep(30);

      if (toX !== undefined && toY !== undefined) {
        // Intermediate positions, because a drag that jumps straight to the end never gives the menu
        // the motion it is meant to be tracking.
        for (let i = 1; i <= 4; i++) {
          post(
            mouseMoveEvent(
              Math.round(x + ((toX - x) * i) / 4),
              Math.round(y + ((toY - y) * i) / 4),
            ),
          );
          await sleep(20);
        }
        post(mouseButtonEvent(toX, toY, false));
        return { content: [{ type: "text", text: `dragged ${x},${y} -> ${toX},${toY}` }] };
      }

      post(mouseButtonEvent(x, y, false));
      return { content: [{ type: "text", text: `clicked ${x},${y}${double ? " (double)" : ""}` }] };
    },
  );

  registerLive(
    "mouse_wheel",
    {
      title: "Scroll the mouse wheel",
      description:
        "Wheel notches at the current pointer position. Positive scrolls up, negative down.",
      inputSchema: { instance: instanceArg, notches: z.number().int() },
    },
    async ({ instance, notches }) => {
      const client = await ctx.clientFor(instance);
      if (!client.supports("event")) {
        return { isError: true, content: [{ type: "text", text: NO_INPUT_CAP }] };
      }
      const count = Math.min(Math.abs(notches), 30);
      for (let i = 0; i < count; i++) {
        const ev = wheelEvent(notches > 0);
        client.sendEvent(ev.evtype, ev.subtype, ev.data1, ev.data2);
        await sleep(25);
      }
      return {
        content: [{ type: "text", text: `${count} notch(es) ${notches > 0 ? "up" : "down"}` }],
      };
    },
  );

  registerLive(
    "verify_menu",
    {
      title: "Open, navigate, and screenshot a menu",
      description:
        "Open a menu (via a console command like `menu_options`), apply navigation steps, then return a screenshot to verify it.",
      inputSchema: {
        instance: instanceArg,
        open: z.string().optional(),
        steps: z.array(z.enum(MENU_KEYS)).default([]),
      },
    },
    async ({ instance, open, steps }, extra) => {
      const client = await ctx.clientFor(instance);
      if (steps.length > 0 && !client.supports("event")) {
        return { isError: true, content: [{ type: "text", text: NO_INPUT_CAP }] };
      }
      // Opening a menu can load assets and the capture waits on a frame, so this
      // runs well past a default client timeout.
      const shot = await withProgress(extra, 34000, "opening and capturing menu", async () => {
        // Opening a menu can load assets, so give it more than the 5s default.
        if (open) await client.runCommand(open, 15000);
        for (const key of steps) {
          postMenuKey(client, key);
          await sleep(60);
        }
        return ctx.io.capture(client, ctx.config.screenshotDir);
      });
      return { content: [{ type: "image", data: shot.base64, mimeType: "image/png" }] };
    },
  );

  // --- time control ----------------------------------------------------------
  // Single-player Zandronum hard-pauses when its window loses focus (no cvar to
  // disable it), which freezes the simulation whenever the MCP drives a
  // backgrounded instance. These tools set the engine's pause flag directly so
  // time-based behavior — charge weapons, projectiles, animations, monster AI —
  // is actually testable headless.
  registerLive(
    "set_pause",
    {
      title: "Pause or resume the game",
      description:
        "Set the engine's master pause flag directly. Use this to resume a backgrounded instance that auto-paused on focus loss, so the simulation keeps advancing while the MCP drives it.",
      inputSchema: { instance: instanceArg, paused: z.boolean() },
    },
    async ({ instance, paused }) => {
      const client = await ctx.clientFor(instance);
      if (!client.supports("time")) {
        return { isError: true, content: [{ type: "text", text: NO_TIME_CAP }] };
      }
      client.setPause(paused);
      return { content: [{ type: "text", text: paused ? "paused" : "resumed" }] };
    },
  );

  registerLive(
    "step",
    {
      title: "Advance the game by N tics",
      description:
        "Resume the game, let it run for the given number of tics (35 tics = 1 second), then pause again. Lets you advance the simulation a deterministic-ish amount to observe time-based effects (charging, projectiles, animations) without keeping the window focused.",
      inputSchema: {
        instance: instanceArg,
        tics: z.number().int().positive().default(35),
      },
    },
    async ({ instance, tics }, extra) => {
      const client = await ctx.clientFor(instance);
      if (!client.supports("time")) {
        return { isError: true, content: [{ type: "text", text: NO_TIME_CAP }] };
      }
      const durationMs = (tics / TICRATE) * 1000;
      client.setPause(false);
      await withProgress(extra, durationMs, `advancing ${tics} tic(s)`, () => sleep(durationMs));
      client.setPause(true);
      return { content: [{ type: "text", text: `advanced ~${tics} tic(s)` }] };
    },
  );

  // --- ACS world/global variable read/write ---------------------------------
  registerLive(
    "get_acs_var",
    {
      title: "Get ACS variable",
      description: "Read an ACS world or global variable by index.",
      inputSchema: { instance: instanceArg, scope: acsScope, index: z.number().int().min(0) },
    },
    async ({ instance, scope, index }) => {
      const client = await ctx.clientFor(instance);
      const output = await client.runCommand(command("getacsvar", scope, index));
      const vars = parseAcsVars(output);
      if (vars.length === 0) {
        return { isError: true, content: [{ type: "text", text: output.join("\n") || "no value" }] };
      }
      return {
        content: [{ type: "text", text: String(vars[0].value) }],
        structuredContent: { scope, index, value: vars[0].value },
      };
    },
  );

  registerLive(
    "set_acs_var",
    {
      title: "Set ACS variable",
      description: "Write an ACS world or global variable by index.",
      inputSchema: {
        instance: instanceArg,
        scope: acsScope,
        index: z.number().int().min(0),
        value: z.number().int(),
      },
    },
    async ({ instance, scope, index, value }) => {
      const client = await ctx.clientFor(instance);
      const output = await client.runCommand(command("setacsvar", scope, index, value));
      const vars = parseAcsVars(output);
      if (vars.length === 0) {
        return {
          isError: true,
          content: [{ type: "text", text: output.join("\n") || "set failed" }],
        };
      }
      return {
        content: [{ type: "text", text: `${scope}[${index}] = ${vars[0].value}` }],
        structuredContent: { scope, index, value: vars[0].value },
      };
    },
  );

  registerLive(
    "list_acs_vars",
    {
      title: "List non-zero ACS variables",
      description:
        "Run `dumpacsvars` and return all non-zero ACS world/global variables, optionally filtered by scope.",
      inputSchema: { instance: instanceArg, scope: acsScope.optional() },
    },
    async ({ instance, scope }) => {
      const client = await ctx.clientFor(instance);
      let vars = parseAcsVars(await client.runCommand("dumpacsvars"));
      if (scope) vars = vars.filter((v) => v.scope === scope);
      return {
        content: [{ type: "text", text: `${vars.length} non-zero ACS var(s)` }],
        structuredContent: { vars },
      };
    },
  );

  // --- static ACS source index (number <-> name <-> file:line) --------------
  server.registerTool(
    "acs_index",
    {
      title: "Index ACS source",
      description:
        "Parse a directory of .acs source files and return symbol counts (scripts, functions, numeric defines). Reads files directly; no game needed.",
      inputSchema: { dir: acsSrcArg },
    },
    async ({ dir }) => {
      const idx = ctx.loadAcsIndex(dir);
      const info = {
        scripts: idx.symbols.filter((s) => s.kind === "script").length,
        functions: idx.symbols.filter((s) => s.kind === "function").length,
        defines: Object.keys(idx.defines).length,
      };
      return { content: [{ type: "text", text: JSON.stringify(info) }], structuredContent: info };
    },
  );

  server.registerTool(
    "find_acs_symbol",
    {
      title: "Find ACS symbol",
      description:
        "Resolve a script number or a script/function name to its symbol(s) — name, number, file:line. Turns a profiler 'script 1017' into a source location.",
      inputSchema: { ref: z.string().min(1), dir: acsSrcArg },
    },
    async ({ ref, dir }) => {
      const matches = findSymbol(ctx.loadAcsIndex(dir), ref);
      return {
        content: [{ type: "text", text: `${matches.length} match(es) for ${ref}` }],
        structuredContent: { matches },
      };
    },
  );

  server.registerTool(
    "behavior_names",
    {
      title: "Read ACS names from compiled bytecode",
      description:
        "Read function and named-script names from a mod's compiled ACS (BEHAVIOR/library lumps) in a WAD or PK3 — for source-less mods. Numbered scripts have no names in bytecode (use find_acs_symbol with source for those).",
      inputSchema: { file: z.string().min(1) },
    },
    async ({ file }) => {
      const functions = new Set<string>();
      const namedScripts = new Set<string>();
      for (const lump of collectAcsLumps(ctx.io.readFileSync(file))) {
        const names = parseBehaviorNames(lump);
        names.functions.forEach((n) => functions.add(n));
        names.namedScripts.forEach((n) => namedScripts.add(n));
      }
      const result = { functions: [...functions], namedScripts: [...namedScripts] };
      return {
        content: [
          {
            type: "text",
            text: `${result.functions.length} functions, ${result.namedScripts.length} named scripts`,
          },
        ],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "list_map_exports",
    {
      title: "List exported map variables from compiled bytecode",
      description:
        "List each ACS module's exported map variables and arrays (MEXP/ARAY chunks) from a WAD, PK3 or compiled .o, with slot index and array size. get_map_var/get_map_array only see exported names, so check here before a launch or pk3 rebuild. `lump` narrows to modules whose name or basename matches (e.g. `mymod` for `acs/mymod.o`).",
      inputSchema: { file: z.string().min(1), lump: z.string().min(1).optional() },
    },
    async ({ file, lump }) => {
      const all = collectAcsModules(ctx.io.readFileSync(file), path.basename(file));
      const want = lump?.toLowerCase();
      const picked = all.filter((m) => {
        const full = m.name.toLowerCase();
        return !want || full === want || path.basename(full).replace(/\.[^.]*$/, "") === want;
      });
      if (picked.length === 0) {
        const known = all.map((m) => m.name).join(", ") || "none";
        return {
          isError: true,
          content: [{ type: "text", text: `No ACS module matches "${lump}" in ${file}. Modules: ${known}` }],
        };
      }
      const modules = picked.map((m) => ({ module: m.name, exports: parseMapExports(m.data) }));
      const text = modules
        .map(({ module, exports }) => {
          const rows = exports.map((e) => `  ${e.index}: ${e.name}${e.isArray ? `[${e.size}]` : ""}`);
          return [`${module}: ${exports.length} export(s)`, ...rows].join("\n");
        })
        .join("\n");
      return { content: [{ type: "text", text }], structuredContent: { modules } };
    },
  );

  // --- savegames & demos -----------------------------------------------------
  server.registerTool(
    "list_saves",
    {
      title: "List savegames",
      description:
        "List .zds savegames in the save directory with metadata (title, map, engine, game wad, creation time) read from each save's PNG text chunks. No running game needed.",
      inputSchema: { dir: z.string().optional() },
    },
    async ({ dir }) => {
      const d = ctx.resolveSaveDir(dir);
      const saves = ctx.io
        .readdirSync(d)
        .filter((f) => f.toLowerCase().endsWith(".zds"))
        .map((f) => readSaveMeta(f, ctx.io.readFileSync(path.join(d, f))));
      return {
        content: [{ type: "text", text: `${saves.length} save(s) in ${d}` }],
        structuredContent: { dir: d, saves },
      };
    },
  );

  registerLive(
    "save_game",
    {
      title: "Save the game",
      description:
        "Run `save` to write a savegame (single-player / cooperative only). NOTE: saving heavily-scripted mods can crash the engine — All-out-War crashes on save; vanilla and simple maps save fine.",
      inputSchema: {
        instance: instanceArg,
        name: z.string().min(1),
        description: z.string().optional(),
      },
    },
    async ({ instance, name, description }) => {
      const client = await ctx.clientFor(instance);
      const out = (await client.runCommand(buildSave(name, description))).join("\n");
      // `save` only queues the write (G_SaveGame sets sendsave), so "Game saved." prints a
      // tic after this reply; every rejection prints in-call.
      return {
        isError: out.trim().length > 0 && !/game saved/i.test(out),
        content: [{ type: "text", text: out.trim() || "save queued; confirm with list_saves" }],
      };
    },
  );

  registerLive(
    "load_game",
    {
      title: "Load a savegame",
      description: "Run `load` to restore a savegame by name.",
      inputSchema: { instance: instanceArg, name: z.string().min(1) },
    },
    async ({ instance, name }) => {
      const client = await ctx.clientFor(instance);
      const out = (await runLoad(client, command("load", name))).join("\n");
      return { content: [{ type: "text", text: out.trim() || "(loaded)" }] };
    },
  );

  registerLive(
    "play_demo",
    {
      title: "Play a demo",
      description:
        "Run `playdemo` to play back a recorded .lmp demo. (Recording is via the -record launch arg, not a console command.)",
      inputSchema: { instance: instanceArg, name: z.string().min(1) },
    },
    async ({ instance, name }) => {
      const client = await ctx.clientFor(instance);
      const out = (await runLoad(client, command("playdemo", name))).join("\n");
      return { content: [{ type: "text", text: out.trim() || "(playing)" }] };
    },
  );

  // --- live player / target state -------------------------------------------
  registerLive(
    "player_state",
    {
      title: "Player state",
      description:
        "Run `currentpos` and return the player's position, angle, floor height, sector, light level, and (on a status-capable bridge) health, armor, and whether the player is alive, dead, or spectating.",
      inputSchema: { instance: instanceArg },
    },
    async ({ instance }) => {
      const client = await ctx.clientFor(instance);
      const parsed = parsePlayerState(await client.runCommand("currentpos"));
      if (!parsed) {
        return { isError: true, content: [{ type: "text", text: "no player (not in a level?)" }] };
      }
      // Already fresh with zero extra round trips: the `currentpos` command
      // above just refreshed `lastStatus` via its own sentinel line.
      const state = withLiveStatus(parsed, client.lastStatus);
      return {
        content: [{ type: "text", text: JSON.stringify(state) }],
        structuredContent: { ...state },
      };
    },
  );

  registerLive(
    "actor_state",
    {
      title: "Actor state (DECORATE)",
      description:
        "Run `dumpactor` and return an actor's live state: class, health, position, angle, pitch, current DECORATE state (sprite/frame/tics, e.g. TNT1 A 0), inventory, and (for players) ready weapon + morph status. Defaults to the player; pass a TID for any actor, plus index for the nth actor sharing it.",
      inputSchema: {
        instance: instanceArg,
        tid: z.number().int().min(0).optional(),
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Pick the nth (0-based) actor sharing the TID; needs tid."),
      },
    },
    async ({ instance, tid, index }) => {
      if (index !== undefined && tid === undefined) {
        return { isError: true, content: [{ type: "text", text: "index needs a tid" }] };
      }
      const client = await ctx.clientFor(instance);
      const cmd =
        tid === undefined
          ? "dumpactor"
          : command("dumpactor", tid, ...(index !== undefined ? [index] : []));
      const state = parseActorState(await client.runCommand(cmd));
      if (state.class === null) {
        return {
          isError: true,
          content: [{ type: "text", text: "no actor (not in a level / bad TID?)" }],
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(state) }],
        structuredContent: { ...state },
      };
    },
  );

  registerLive(
    "read_hud",
    {
      title: "Read on-screen HUD",
      description:
        "Run `dumphud` and return everything the engine painted last frame: HUD text strings (with screen x/y), images (by texture name + position), and active ACS HUD messages (full composed text, layer, position, remaining tics). Captures menus too.",
      inputSchema: { instance: instanceArg },
    },
    async ({ instance }) => {
      const client = await ctx.clientFor(instance);
      const hud = parseHud(await client.runCommand("dumphud"));
      return {
        content: [
          {
            type: "text",
            text: `${hud.text.length} strings, ${hud.images.length} images, ${hud.messages.length} hud messages`,
          },
        ],
        structuredContent: { ...hud },
      };
    },
  );

  registerLive(
    "actors_near",
    {
      title: "Actors near the player",
      description:
        "Run `actorsnear` and return actors within a radius (map units, default 512) of the player: class, health, position, and current sprite.",
      inputSchema: { instance: instanceArg, radius: z.number().int().positive().optional() },
    },
    async ({ instance, radius }) => {
      const client = await ctx.clientFor(instance);
      const cmd = radius !== undefined ? command("actorsnear", radius) : "actorsnear";
      const actors = parseActorsNear(await client.runCommand(cmd));
      return {
        content: [{ type: "text", text: `${actors.length} actor(s) nearby` }],
        structuredContent: { actors },
      };
    },
  );

  registerLive(
    "inspect_target",
    {
      title: "Inspect aimed target",
      description:
        "Run `linetarget` and return the actor the player is aiming at (class, health, spawn health).",
      inputSchema: { instance: instanceArg },
    },
    async ({ instance }) => {
      const client = await ctx.clientFor(instance);
      const target = parseTarget(await client.runCommand("linetarget"));
      if (!target) {
        return { content: [{ type: "text", text: "no target in view" }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(target) }],
        structuredContent: { ...target },
      };
    },
  );

  registerLive(
    "set_cheat",
    {
      title: "Set a cheat on or off",
      description:
        "Idempotently turn a player cheat on or off. Reads the cheat bit from the engine-state snapshot and only runs the stock toggle CCMD (god, notarget, ...) when it differs, then waits for the bit to flip, so a blind toggle can never switch it the wrong way. Uses the engine's normal net path. Needs a bridge with the status cap and a cheats= field.",
      inputSchema: {
        instance: instanceArg,
        name: z.enum(CHEAT_NAMES),
        on: z.boolean(),
      },
    },
    async ({ instance, name, on }) => {
      const client = await ctx.clientFor(instance);
      const bit = CHEATS[name];
      const read = () => {
        const cheats = client.lastStatus?.cheats;
        return cheats === undefined ? undefined : (Number(cheats) & bit) !== 0;
      };
      await client.refreshStatus();
      if (read() === undefined) {
        const why = client.lastStatus
          ? "the engine's status snapshot has no cheats= field (rebuild the engine with the latest overlay), or there is no player"
          : "this engine bridge has no status support (rebuild with the latest bridge)";
        return { isError: true, content: [{ type: "text", text: `can't read cheat state: ${why}` }] };
      }
      const want = on ? "on" : "off";
      if (read() === on) {
        return { content: [{ type: "text", text: `${name} already ${want}; no change` }] };
      }
      const output = await client.runCommand(name);
      for (let i = 0; i < CHEAT_POLLS && read() !== on; i++) {
        await sleep(CHEAT_POLL_MS);
        await client.refreshStatus();
      }
      if (read() !== on) {
        const said = output.join("\n").trim() || "(no output)";
        return {
          isError: true,
          content: [{ type: "text", text: `${name} did not turn ${want}; the engine said: ${said}` }],
        };
      }
      return { content: [{ type: "text", text: `${name} ${want}` }] };
    },
  );

  registerLive(
    "set_view",
    {
      title: "Set the player's view",
      description:
        "Point the player's view: an absolute angle (degrees, Doom convention: 0 east, 90 north) with optional pitch (degrees, negative looks up), or face an actor by tid (first actor with it) or class (nearest map actor of that class, aiming at its mid-height). Give exactly one of angle, tid, class.",
      inputSchema: {
        instance: instanceArg,
        angle: z.number().finite().optional(),
        pitch: z.number().finite().optional(),
        tid: z.number().int().min(1).optional(),
        class: className.optional(),
      },
    },
    async ({ instance, angle, pitch, tid, class: cls }) => {
      const modes = [angle, tid, cls].filter((m) => m !== undefined).length;
      if (modes !== 1 || (pitch !== undefined && angle === undefined)) {
        return {
          isError: true,
          content: [
            { type: "text", text: "give exactly one of angle, tid or class (pitch only with angle)" },
          ],
        };
      }
      const cmd =
        angle !== undefined
          ? command("mcp_setview", String(angle), ...(pitch !== undefined ? [String(pitch)] : []))
          : command("mcp_setview", ...kvArgs({ tid, class: cls }));
      const client = await ctx.clientFor(instance);
      const output = await client.runCommand(cmd);
      const view = parseKvLines(output, "view")[0];
      if (!view) return failed(output);
      return {
        content: [{ type: "text", text: JSON.stringify(view) }],
        structuredContent: { ...view },
      };
    },
  );

  registerLive(
    "list_players",
    {
      title: "List players",
      description:
        "Run `dumpplayers` and return every in-game player: slot, bot, spectator/dead-spectator, player state, health, armor, ready weapon, x/y/z, angle, pitch, TID, cheat bits, frags, deaths, kills/items/secrets, points, wins, team, ping and name. Bots join at slot 1+.",
      inputSchema: { instance: instanceArg },
    },
    async ({ instance }) => {
      const client = await ctx.clientFor(instance);
      const output = await client.runCommand("dumpplayers");
      if (!hasHeader(output, "MCP_PLAYERS")) return failed(output);
      const players = parsePlayers(output);
      return {
        content: [{ type: "text", text: `${players.length} player(s)` }],
        structuredContent: { players },
      };
    },
  );

  registerLive(
    "find_actors",
    {
      title: "Find actors map-wide",
      description:
        "Run `findactors` and list map actors (owned inventory excluded), optionally filtered by class (includes subclasses), TID and radius around the player, sorted by distance. Each has class, tid, hp/spawnhp, x/y/z, angle, pitch, dist, sprite/frame, flags (monster, friendly, corpse, dormant, shootable, solid, invulnerable, ambush) and target. detail adds master/tracer, special + args, vel, radius/height, floorz and player index. With a tid filter each result also has index, the one to pass to actor_state(tid, index) for it (the list is in distance order, not index order).",
      inputSchema: {
        instance: instanceArg,
        class: className.optional(),
        tid: z.number().int().min(1).optional(),
        radius: z.number().int().positive().optional(),
        limit: z.number().int().positive().optional(),
        detail: z.boolean().optional(),
      },
    },
    async ({ instance, class: cls, tid, radius, limit, detail }) => {
      const args = kvArgs({ class: cls, tid, radius, limit, detail: detail ? 1 : undefined });
      const client = await ctx.clientFor(instance);
      const output = await client.runCommand(command("findactors", ...args));
      if (firstError(output) !== undefined || !hasHeader(output, "MCP_FOUND")) return failed(output);
      const found = parseFindActors(output);
      const cut = found.truncated ? ` (showing ${found.truncated.shown} of ${found.truncated.total})` : "";
      return {
        content: [{ type: "text", text: `${found.actors.length} actor(s) found${cut}` }],
        structuredContent: { ...found },
      };
    },
  );

  // --- ACS scripts / functions / profiling ----------------------------------
  registerLive(
    "list_scripts",
    {
      title: "List ACS scripts",
      description:
        "Run `dumpscripts` and return every script across loaded modules (module, number, name, type, arg count).",
      inputSchema: { instance: instanceArg },
    },
    async ({ instance }) => {
      const client = await ctx.clientFor(instance);
      const scripts = parseScripts(await client.runCommand("dumpscripts"));
      return {
        content: [{ type: "text", text: `${scripts.length} script(s)` }],
        structuredContent: { scripts },
      };
    },
  );

  registerLive(
    "list_functions",
    {
      title: "List ACS functions",
      description: "Run `dumpfunctions` and return named ACS functions across loaded modules.",
      inputSchema: { instance: instanceArg },
    },
    async ({ instance }) => {
      const client = await ctx.clientFor(instance);
      const functions = parseFunctions(await client.runCommand("dumpfunctions"));
      return {
        content: [{ type: "text", text: `${functions.length} function(s)` }],
        structuredContent: { functions },
      };
    },
  );

  registerLive(
    "profile_scripts",
    {
      title: "Profile ACS scripts",
      description:
        "Run `acsprofile` and return per-script/function execution stats (total instructions, runs, avg/min/max).",
      inputSchema: { instance: instanceArg, sort: profileSort, limit: profileLimit },
    },
    async ({ instance, sort, limit }) => {
      const client = await ctx.clientFor(instance);
      const entries = parseAcsProfile(await client.runCommand(profileCommand(sort, limit)));
      return {
        content: [{ type: "text", text: `${entries.length} profiled` }],
        structuredContent: { entries },
      };
    },
  );

  registerLive(
    "profile_window",
    {
      title: "Profile a time window",
      description:
        "Clear ACS profiling, wait N seconds, then return what ran during that window — `what's hot right now` rather than cumulative since map start.",
      inputSchema: {
        instance: instanceArg,
        seconds: z.number().int().min(1).max(30).default(3),
        sort: profileSort,
        limit: profileLimit,
      },
    },
    async ({ instance, seconds, sort, limit }, extra) => {
      const client = await ctx.clientFor(instance);
      await client.runCommand("acsprofile clear");
      await withProgress(extra, seconds * 1000, `sampling for ${seconds}s`, () =>
        sleep(seconds * 1000),
      );
      const entries = parseAcsProfile(await client.runCommand(profileCommand(sort, limit)));
      return {
        content: [{ type: "text", text: `${entries.length} profiled over ${seconds}s` }],
        structuredContent: { entries },
      };
    },
  );

  // --- map-scope ACS variables/arrays (by name, across loaded modules) ------
  registerLive(
    "list_modules",
    {
      title: "List loaded ACS modules",
      description:
        "Run `dumpmodules` and return the loaded ACS modules (id + name). Map vars live only while a map is loaded.",
      inputSchema: { instance: instanceArg },
    },
    async ({ instance }) => {
      const client = await ctx.clientFor(instance);
      const modules = parseModules(await client.runCommand("dumpmodules"));
      return {
        content: [{ type: "text", text: `${modules.length} module(s)` }],
        structuredContent: { modules },
      };
    },
  );

  registerLive(
    "get_map_var",
    {
      title: "Get map variable",
      description: "Read a map-scope ACS variable by name (searched across loaded modules).",
      inputSchema: { instance: instanceArg, name: acsName },
    },
    async ({ instance, name }) => {
      const client = await ctx.clientFor(instance);
      const value = parseMapVar(await client.runCommand(command("getmapvar", name)));
      if (value === null) {
        return { isError: true, content: [{ type: "text", text: `map var '${name}' not found` }] };
      }
      return { content: [{ type: "text", text: String(value) }], structuredContent: { name, value } };
    },
  );

  registerLive(
    "set_map_var",
    {
      title: "Set map variable",
      description: "Write a map-scope ACS variable by name.",
      inputSchema: { instance: instanceArg, name: acsName, value: z.number().int() },
    },
    async ({ instance, name, value }) => {
      const client = await ctx.clientFor(instance);
      const result = parseMapVar(await client.runCommand(command("setmapvar", name, value)));
      if (result === null) {
        return { isError: true, content: [{ type: "text", text: `map var '${name}' not found` }] };
      }
      return {
        content: [{ type: "text", text: `${name} = ${result}` }],
        structuredContent: { name, value: result },
      };
    },
  );

  registerLive(
    "get_map_array",
    {
      title: "Get map array element",
      description: "Read one element of a map-scope ACS array by name and index.",
      inputSchema: { instance: instanceArg, name: acsName, index: z.number().int().min(0) },
    },
    async ({ instance, name, index }) => {
      const client = await ctx.clientFor(instance);
      const value = parseMapArray(await client.runCommand(command("getmaparray", name, index)));
      if (value === null) {
        return { isError: true, content: [{ type: "text", text: `map array '${name}' not found` }] };
      }
      return {
        content: [{ type: "text", text: String(value) }],
        structuredContent: { name, index, value },
      };
    },
  );

  registerLive(
    "set_map_array",
    {
      title: "Set map array element",
      description: "Write one element of a map-scope ACS array by name and index.",
      inputSchema: {
        instance: instanceArg,
        name: acsName,
        index: z.number().int().min(0),
        value: z.number().int(),
      },
    },
    async ({ instance, name, index, value }) => {
      const client = await ctx.clientFor(instance);
      const result = parseMapArray(
        await client.runCommand(command("setmaparray", name, index, value)),
      );
      if (result === null) {
        return { isError: true, content: [{ type: "text", text: `map array '${name}' not found` }] };
      }
      return {
        content: [{ type: "text", text: `${name}[${index}] = ${result}` }],
        structuredContent: { name, index, value: result },
      };
    },
  );

  // --- renderer / UI inspection (read-only) ---------------------------------
  async function renderInfo(instance: number) {
    const client = await ctx.clientFor(instance);
    return parseRenderInfo(await client.runCommand("dumprenderer"));
  }

  registerLive(
    "renderer_info",
    {
      title: "Renderer info",
      description:
        "Active backend (software/opengl), GL vendor/shader model, resolution, fullscreen/vsync.",
      inputSchema: { instance: instanceArg },
    },
    async ({ instance }) => {
      const info = pick(await renderInfo(instance), [
        "renderer",
        "gl_vendor",
        "gl_shadermodel",
        "gl_maxtexsize",
        "screen_width",
        "screen_height",
        "vid_renderer",
        "fullscreen",
        "vid_vsync",
        "vid_defwidth",
        "vid_defheight",
      ]);
      return { content: [{ type: "text", text: JSON.stringify(info) }], structuredContent: info };
    },
  );

  registerLive(
    "viewport_info",
    {
      title: "Viewport info",
      description: "The 3D view window rect (x/y/width/height) and screenblocks size.",
      inputSchema: { instance: instanceArg },
    },
    async ({ instance }) => {
      const info = pick(await renderInfo(instance), [
        "view_x",
        "view_y",
        "view_width",
        "view_height",
        "screenblocks",
      ]);
      return { content: [{ type: "text", text: JSON.stringify(info) }], structuredContent: info };
    },
  );

  registerLive(
    "hud_info",
    {
      title: "HUD info",
      description: "Status bar Y position, status bar / HUD scale, alt HUD, crosshair.",
      inputSchema: { instance: instanceArg },
    },
    async ({ instance }) => {
      const info = pick(await renderInfo(instance), [
        "statusbar_y",
        "st_scale",
        "hud_scale",
        "hud_althud",
        "crosshair",
      ]);
      return { content: [{ type: "text", text: JSON.stringify(info) }], structuredContent: info };
    },
  );

  // --- map geometry (read-only) ---------------------------------------------
  server.registerTool(
    "map_info",
    {
      title: "Map info",
      description:
        "Read a map from a WAD and return its format (doom/hexen/udmf) and entity counts. Reads the file directly — the game need not be running.",
      inputSchema: { map: z.string().min(1), file: mapFileArg },
    },
    async ({ map, file }) => {
      const data = ctx.loadMap(file, map);
      const info = {
        format: data.format,
        sectors: data.sectors.length,
        linedefs: data.linedefs.length,
        sidedefs: data.sidedefs.length,
        vertices: data.vertices.length,
      };
      return { content: [{ type: "text", text: JSON.stringify(info) }], structuredContent: info };
    },
  );

  server.registerTool(
    "get_sector",
    {
      title: "Get sector",
      description: "Return one sector's properties by index (all fields, format-native keys).",
      inputSchema: { map: z.string().min(1), index: z.number().int().min(0), file: mapFileArg },
    },
    async ({ map, index, file }) => {
      const data = ctx.loadMap(file, map);
      const sector = data.sectors[index];
      if (!sector) {
        return {
          isError: true,
          content: [
            { type: "text", text: `No sector ${index} (map has ${data.sectors.length}).` },
          ],
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(sector) }],
        structuredContent: { sector },
      };
    },
  );

  server.registerTool(
    "get_linedef",
    {
      title: "Get linedef",
      description:
        "Return one linedef by index, with its referenced sidedefs (textures + offsets) resolved.",
      inputSchema: { map: z.string().min(1), index: z.number().int().min(0), file: mapFileArg },
    },
    async ({ map, index, file }) => {
      const data = ctx.loadMap(file, map);
      const line = data.linedefs[index];
      if (!line) {
        return {
          isError: true,
          content: [
            { type: "text", text: `No linedef ${index} (map has ${data.linedefs.length}).` },
          ],
        };
      }
      const sides = ["front", "back", "sidefront", "sideback"]
        .map((k) => line[k])
        .filter((v): v is number => typeof v === "number" && v >= 0)
        .map((i) => data.sidedefs[i])
        .filter(Boolean);
      const result = { line, sides };
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    },
  );

  server.registerTool(
    "find_sectors_by_tag",
    {
      title: "Find sectors by tag",
      description: "Return all sectors whose tag/id matches (binary `tag` or UDMF `id`).",
      inputSchema: { map: z.string().min(1), tag: z.number().int(), file: mapFileArg },
    },
    async ({ map, tag, file }) => {
      const data = ctx.loadMap(file, map);
      const sectors = data.sectors.filter((s) => s.tag === tag || s.id === tag);
      return {
        content: [{ type: "text", text: `${sectors.length} sector(s) with tag ${tag}` }],
        structuredContent: { sectors },
      };
    },
  );

  // --- process management ----------------------------------------------------
  registerLive(
    "launch_instance",
    {
      title: "Launch a Zandronum instance",
      description:
        "Spawn a bridge-enabled Zandronum process with the given options and attach to it. Requires ZANDRONUM_EXE to be set.",
      inputSchema: {
        instance: instanceArg,
        iwad: z.string().optional(),
        files: z.array(z.string()).optional(),
        map: z.string().optional(),
        skill: z.number().int().min(1).max(5).optional(),
        fullscreen: z.boolean().optional(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        extraArgs: z.array(z.string()).optional(),
      },
    },
    async ({ instance, iwad, files, map, skill, fullscreen, width, height, extraArgs }, extra) => {
      const exe = ctx.config.exe;
      if (!exe) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Set ZANDRONUM_EXE to the engine path (zandronum.exe on Windows, Zandronum.app on macOS, ./zandronum on Linux) to launch instances.",
            },
          ],
        };
      }
      if (!ctx.io.existsSync(exe)) {
        return {
          isError: true,
          content: [{ type: "text", text: `ZANDRONUM_EXE not found at ${exe} — check the path.` }],
        };
      }
      if (!ctx.io.hasBridge(exe)) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `ZANDRONUM_EXE at ${exe} has no MCP bridge — that looks like a stock Zandronum (or GZDoom), which the MCP can't drive. Point it at a bridge-patched build: download one from the GitHub Releases, or build it yourself (see docs/ADVANCED.md).`,
            },
          ],
        };
      }
      // Pick the first free port at/above the conventional one for this instance, so a
      // stale engine (or anything) squatting the default port can't cause a mis-attach.
      const port = await ctx.io.findFreePort(ctx.portFor(instance));
      const logFile = path.join(path.dirname(exe), `mcp-bridge-${port}.log`);
      ctx.rememberLaunch(instance, port, logFile);
      try {
        // The engine can take tens of seconds to boot a big mod and open its
        // bridge — well past a default client timeout, so report progress.
        const client = await withProgress(extra, 42000, "waiting for the engine", () =>
          ctx.registry.launch(
            {
              id: instance,
              exe,
              cwd: path.dirname(exe),
              port,
              logFile,
              iwad,
              files,
              map,
              skill,
              fullscreen,
              width,
              height,
              extraArgs,
            },
            ctx.io.launchIo,
          ),
        );
        // Remember which process this is, so a later re-attach can tell if the
        // engine died and something else took its port.
        ctx.rememberEngine(instance, client.enginePid);
      } catch (e) {
        // The bridge never opened. Most often that's a DECORATE/ACS compile error
        // that aborted startup — surface it from the captured log instead of just
        // reporting the timeout.
        const msg = e instanceof Error ? e.message : String(e);
        let detail =
          " (no compile errors found in the engine log — it may have crashed, or the bridge build is stale)";
        if (ctx.io.existsSync(logFile)) {
          const errs = parseStartupErrors(ctx.io.readTextSync(logFile));
          if (errs.length) detail = `\n\nEngine log shows:\n${errs.join("\n")}`;
        }
        return {
          isError: true,
          content: [
            { type: "text", text: `Instance ${instance} failed to come up: ${msg}.${detail}` },
          ],
        };
      }
      return { content: [{ type: "text", text: `launched instance ${instance} on bridge port ${port}` }] };
    },
  );

  registerLive(
    "attach_instance",
    {
      title: "Attach to an engine you started yourself",
      description:
        "Connect to a bridge-patched Zandronum that is ALREADY running — one you launched by hand, or from a terminal — and bind it to an instance number for the other tools. Only needed for engines this session didn't launch: launch_instance binds automatically. Defaults to this instance's conventional port.",
      inputSchema: { instance: instanceArg, port: z.number().int().positive().optional() },
    },
    async ({ instance, port }) => {
      const target = port ?? ctx.portFor(instance);
      ctx.bind(instance, target);
      try {
        const client = await ctx.clientFor(instance);
        ctx.rememberEngine(instance, client.enginePid);
        const pid = client.enginePid !== undefined ? ` (engine PID ${client.enginePid})` : "";
        return {
          content: [{ type: "text", text: `attached instance ${instance} to port ${target}${pid}` }],
        };
      } catch (e) {
        // Don't leave a binding pointing at something we couldn't reach.
        ctx.forgetInstance(instance);
        const msg = e instanceof Error ? e.message : String(e);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Could not attach instance ${instance} to port ${target}: ${msg}. Is a bridge-patched engine listening there?`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "kill_instance",
    {
      title: "Kill a Zandronum instance",
      description:
        "Stop a launched instance and detach from it. Asks the engine to quit itself first (a hard kill mid-render can wedge macOS GPU teardown and leave an unkillable process), then force-kills if it doesn't exit.",
      inputSchema: { instance: instanceArg },
    },
    async ({ instance }) => {
      const clean = await ctx.registry.quit(instance);
      ctx.forgetInstance(instance);
      return {
        content: [
          {
            type: "text",
            text: clean
              ? `instance ${instance} quit cleanly`
              : `instance ${instance} did not quit on request — force-killed`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "reset",
    {
      title: "Reset — reap this session's engine instances",
      description:
        "Kill every instance this session launched, and reap engines ORPHANED by earlier sessions (whose launcher is gone) that could otherwise squat bridge ports. Engines belonging to another running editor window are left alone. Pass all:true to also kill those — only do that if you know no other session is using this engine build.",
      inputSchema: {
        all: z
          .boolean()
          .default(false)
          .describe("Also kill engines owned by other live MCP sessions using this same build."),
      },
    },
    async ({ all }) => {
      ctx.registry.closeAll();
      ctx.forgetAll();
      if (!ctx.config.exe) {
        return {
          content: [
            { type: "text", text: "Reset tracked instances. (ZANDRONUM_EXE unset, so no orphan sweep.)" },
          ],
        };
      }
      // Orphans-only by default: a process whose parent is still alive belongs to
      // somebody else's session, and killing it would take down their game.
      const r = await ctx.io.reap(ctx.config.exe, { onlyOrphans: !all });
      const scope = all ? "engine process(es)" : "orphaned engine process(es)";
      const lines = [`Reset complete. Reaped ${r.killed.length} ${scope}.`];
      if (r.survivors.length) {
        lines.push(
          `${r.survivors.length} process(es) survived SIGKILL (PIDs ${r.survivors.join(", ")}) — ` +
            `these are wedged in the OS (macOS window-server exit-hang) and need a manual ` +
            `force-quit (Activity Monitor) or a logout to clear.`,
        );
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.registerTool(
    "get_startup_errors",
    {
      title: "Get engine startup errors",
      description:
        "Read the engine's captured console log for an instance and surface DECORATE/ACS compile errors and fatal startup errors. Works even when the bridge never came up (e.g. the engine aborted on a bad script) — exactly when the other tools can't connect.",
      inputSchema: { instance: instanceArg },
    },
    async ({ instance }) => {
      const logFile = ctx.logPathFor(instance);
      if (!logFile || !ctx.io.existsSync(logFile)) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `No engine log for instance ${instance}. Launch it via launch_instance (which enables logging), then re-run this if it failed to start.`,
            },
          ],
        };
      }
      const log = ctx.io.readTextSync(logFile);
      const errors = parseStartupErrors(log);
      const body = errors.length
        ? `Detected ${errors.length} error line(s) in the engine log:\n\n${errors.join("\n")}`
        : `No compile/fatal errors detected. Last lines of the engine log for context:\n\n${tailLines(log).join("\n")}`;
      return { content: [{ type: "text", text: body }] };
    },
  );

  server.registerTool(
    "read_log",
    {
      title: "Read the engine console log",
      description:
        "Read an instance's engine console log, which catches prints that never come back in a command reply (e.g. cheat ON/OFF messages, emitted a tic later). Correlation sentinel lines are dropped. `pattern` is a case-insensitive regex filter. Without `sinceLine` this returns the last `maxLines` matches; with it, the first `maxLines` matches after that line. Pass the returned `nextLine` as `sinceLine` to read only what was logged since.",
      inputSchema: {
        instance: instanceArg,
        pattern: z.string().min(1).optional(),
        sinceLine: z.number().int().nonnegative().optional(),
        maxLines: z.number().int().positive().default(200),
      },
    },
    async ({ instance, pattern, sinceLine, maxLines }) => {
      const logFile = ctx.logPathFor(instance);
      if (!logFile || !ctx.io.existsSync(logFile)) {
        return {
          isError: true,
          content: [{ type: "text", text: `No engine log for instance ${instance}. Launch it via launch_instance, which enables logging.` }],
        };
      }
      const win = readLogWindow(ctx.io.readTextSync(logFile), { pattern, sinceLine, maxLines });
      const head =
        `${win.lines.length} line(s), nextLine=${win.nextLine}` +
        (win.omitted ? `, ${win.omitted} more matching line(s) not shown` : "");
      const text = [head, ...win.lines.map((l) => `${l.line}: ${l.text}`)].join("\n");
      return { content: [{ type: "text", text }], structuredContent: { ...win } };
    },
  );

  server.registerTool(
    "get_crash",
    {
      title: "Get the last engine crash backtrace",
      description:
        "Return the signal, faulting address, and symbolized backtrace the bridge's crash handler captured the last time the engine crashed (segfault/abort/bus error/etc.). Use this when an instance dies unexpectedly — e.g. run_command reports the bridge closed. Empty if the instance has not crashed.",
      inputSchema: { instance: instanceArg },
    },
    async ({ instance }) => {
      const logFile = ctx.logPathFor(instance);
      const crashFile = logFile ? crashLogPath(logFile) : undefined;
      if (!crashFile || !ctx.io.existsSync(crashFile)) {
        return {
          content: [
            {
              type: "text",
              text: `No crash recorded for instance ${instance}. (The engine writes a backtrace here only when it dies on a fatal signal.)`,
            },
          ],
        };
      }
      return { content: [{ type: "text", text: ctx.io.readTextSync(crashFile) }] };
    },
  );
}
