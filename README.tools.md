# Tools

> **Auto-generated** from `src/tools.ts` by `scripts/gen-tools-doc.mjs` — do not
> edit by hand; run `npm run docs:tools` to regenerate.

The MCP server exposes **58 tools**. Your agent also discovers them at
runtime via each tool's `description`, so this is mainly for browsing.

## Commands, cheats & input

- **`run_command`** — Send a raw console command to a running, bridge-patched Zandronum instance and return its captured output.
- **`list_actor_classes`** — Run `dumpactors` and return the registered DECORATE/actor classes as structured data.
- **`summon`** — Spawn an actor of the given class at the player's position.
- **`give`** — Give an inventory item to the player.
- **`take`** — Remove an inventory item from the player.
- **`load_map`** — Load a map by its lump name (e.g. MAP01, E1M1).
- **`list_running_scripts`** — Run `scriptstat` and return the currently running ACS scripts and their states.
- **`run_script`** — Run (puke) an ACS script by number or name, with optional integer arguments.
- **`screenshot`** — Take a screenshot of the game and return it as an image so it can be viewed.
- **`screenshot_file`** — Take a screenshot and leave it on disk, returning only its absolute path (no image content). For measuring pixels with a script instead of viewing the frame. A reused `name` overwrites that file.
- **`menu_key`** — Send a single menu navigation key (GUI key event) to the active menu.
- **`menu_nav`** — Send a sequence of menu keys (e.g. ["down","down","enter"]) with a small delay between each.
- **`menu_text`** — Type a string into the active menu text-entry field (e.g. the player name box after pressing enter on it), one character at a time.
- **`mouse_move`** — Move the pointer to a screen position, in pixels from the top-left of the game window. Drives hover-only UI -- tooltips, hot states -- which nothing else here can reach.
- **`mouse_click`** — Press and release the left button at a position. Give toX/toY to DRAG: press at the first point, move through it, release at the second. `double` sends a double-click.
- **`mouse_wheel`** — Wheel notches at the current pointer position. Positive scrolls up, negative down.
- **`verify_menu`** — Open a menu (via a console command like `menu_options`), apply navigation steps, then return a screenshot to verify it.

## Time control

- **`set_pause`** — Set the engine's master pause flag directly. Use this to resume a backgrounded instance that auto-paused on focus loss, so the simulation keeps advancing while the MCP drives it.
- **`step`** — Resume the game, let it run for the given number of tics (35 tics = 1 second), then pause again. Lets you advance the simulation a deterministic-ish amount to observe time-based effects (charging, projectiles, animations) without keeping the window focused.

## ACS world/global variable read/write

- **`get_acs_var`** — Read an ACS world or global variable by index.
- **`set_acs_var`** — Write an ACS world or global variable by index.
- **`list_acs_vars`** — Run `dumpacsvars` and return all non-zero ACS world/global variables, optionally filtered by scope.

## Static ACS source index

- **`acs_index`** — Parse a directory of .acs source files and return symbol counts (scripts, functions, numeric defines). Reads files directly; no game needed.
- **`find_acs_symbol`** — Resolve a script number or a script/function name to its symbol(s) — name, number, file:line. Turns a profiler 'script 1017' into a source location.
- **`behavior_names`** — Read function and named-script names from a mod's compiled ACS (BEHAVIOR/library lumps) in a WAD or PK3 — for source-less mods. Numbered scripts have no names in bytecode (use find_acs_symbol with source for those).
- **`list_map_exports`** — List each ACS module's exported map variables and arrays (MEXP/ARAY chunks) from a WAD, PK3 or compiled .o, with slot index and array size. get_map_var/get_map_array only see exported names, so check here before a launch or pk3 rebuild. `lump` narrows to modules whose name or basename matches (e.g. `mymod` for `acs/mymod.o`).

## Savegames & demos

- **`list_saves`** — List .zds savegames in the save directory with metadata (title, map, engine, game wad, creation time) read from each save's PNG text chunks. No running game needed.
- **`save_game`** — Run `save` to write a savegame (single-player / cooperative only). NOTE: saving heavily-scripted mods can crash the engine — All-out-War crashes on save; vanilla and simple maps save fine.
- **`load_game`** — Run `load` to restore a savegame by name.
- **`play_demo`** — Run `playdemo` to play back a recorded .lmp demo. (Recording is via the -record launch arg, not a console command.)

## Live player / target state

- **`player_state`** — Run `currentpos` and return the player's position, angle, floor height, sector, light level, and (on a status-capable bridge) health, armor, and whether the player is alive, dead, or spectating.
- **`actor_state`** — Run `dumpactor` and return an actor's live state: class, health, position, current DECORATE state (sprite/frame/tics, e.g. TNT1 A 0), inventory, and (for players) ready weapon + morph status. Defaults to the player; pass a TID for any actor.
- **`read_hud`** — Run `dumphud` and return everything the engine painted last frame: HUD text strings (with screen x/y), images (by texture name + position), and active ACS HUD messages (full composed text, layer, position, remaining tics). Captures menus too.
- **`actors_near`** — Run `actorsnear` and return actors within a radius (map units, default 512) of the player: class, health, position, and current sprite.
- **`inspect_target`** — Run `linetarget` and return the actor the player is aiming at (class, health, spawn health).

## ACS scripts / functions / profiling

- **`list_scripts`** — Run `dumpscripts` and return every script across loaded modules (module, number, name, type, arg count).
- **`list_functions`** — Run `dumpfunctions` and return named ACS functions across loaded modules.
- **`profile_scripts`** — Run `acsprofile` and return per-script/function execution stats (total instructions, runs, avg/min/max).
- **`profile_window`** — Clear ACS profiling, wait N seconds, then return what ran during that window — `what's hot right now` rather than cumulative since map start.

## Map-scope ACS variables/arrays

- **`list_modules`** — Run `dumpmodules` and return the loaded ACS modules (id + name). Map vars live only while a map is loaded.
- **`get_map_var`** — Read a map-scope ACS variable by name (searched across loaded modules).
- **`set_map_var`** — Write a map-scope ACS variable by name.
- **`get_map_array`** — Read one element of a map-scope ACS array by name and index.
- **`set_map_array`** — Write one element of a map-scope ACS array by name and index.

## Renderer / UI inspection

- **`renderer_info`** — Active backend (software/opengl), GL vendor/shader model, resolution, fullscreen/vsync.
- **`viewport_info`** — The 3D view window rect (x/y/width/height) and screenblocks size.
- **`hud_info`** — Status bar Y position, status bar / HUD scale, alt HUD, crosshair.

## Map geometry

- **`map_info`** — Read a map from a WAD and return its format (doom/hexen/udmf) and entity counts. Reads the file directly — the game need not be running.
- **`get_sector`** — Return one sector's properties by index (all fields, format-native keys).
- **`get_linedef`** — Return one linedef by index, with its referenced sidedefs (textures + offsets) resolved.
- **`find_sectors_by_tag`** — Return all sectors whose tag/id matches (binary `tag` or UDMF `id`).

## Process management

- **`launch_instance`** — Spawn a bridge-enabled Zandronum process with the given options and attach to it. Requires ZANDRONUM_EXE to be set.
- **`attach_instance`** — Connect to a bridge-patched Zandronum that is ALREADY running — one you launched by hand, or from a terminal — and bind it to an instance number for the other tools. Only needed for engines this session didn't launch: launch_instance binds automatically. Defaults to this instance's conventional port.
- **`kill_instance`** — Stop a launched instance and detach from it. Asks the engine to quit itself first (a hard kill mid-render can wedge macOS GPU teardown and leave an unkillable process), then force-kills if it doesn't exit.
- **`reset`** — Kill every instance this session launched, and reap engines ORPHANED by earlier sessions (whose launcher is gone) that could otherwise squat bridge ports. Engines belonging to another running editor window are left alone. Pass all:true to also kill those — only do that if you know no other session is using this engine build.
- **`get_startup_errors`** — Read the engine's captured console log for an instance and surface DECORATE/ACS compile errors and fatal startup errors. Works even when the bridge never came up (e.g. the engine aborted on a bad script) — exactly when the other tools can't connect.
- **`read_log`** — Read an instance's engine console log, which catches prints that never come back in a command reply (e.g. cheat ON/OFF messages, emitted a tic later). Correlation sentinel lines are dropped. `pattern` is a case-insensitive regex filter. Without `sinceLine` this returns the last `maxLines` matches; with it, the first `maxLines` matches after that line. Pass the returned `nextLine` as `sinceLine` to read only what was logged since.
- **`get_crash`** — Return the signal, faulting address, and symbolized backtrace the bridge's crash handler captured the last time the engine crashed (segfault/abort/bus error/etc.). Use this when an instance dies unexpectedly — e.g. run_command reports the bridge closed. Empty if the instance has not crashed.
