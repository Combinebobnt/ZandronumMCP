# Bridge protocol (v1)

The single source of truth for the wire contract between the **engine bridge**
(`engine-bridge/overlay/mcp_bridge.cpp`) and the **MCP server** (`src/`).

- **Transport:** loopback TCP, `127.0.0.1` only. Instance _N_ listens on
  `ZANDRONUM_BRIDGE_PORT + (N - 1)`.
- **Framing:** newline-delimited JSON (NDJSON). One JSON object per line.
- **Versioning:** every message carries `"v"`. The client checks the `hello`
  version and refuses to proceed on mismatch. Bump `v` ONLY when this contract
  changes (independent of npm semver and of the engine tag).

## Messages

### engine → MCP

`hello` — sent once, immediately on connect. `caps` lists what the bridge
supports so the client can degrade gracefully:
```json
{"v":1,"t":"hello","engine":"zandronum","bridge":"0.3.0","caps":["cmd","event","time"]}
```

`caps` values: `cmd` (console commands), `event` (input events), `time` (the
`setpause` control below), `status` (the `mcp_status` CCMD used for the
engine-state note described under Correlation).

`out` — one line of console output, streamed asynchronously:
```json
{"v":1,"t":"out","level":0,"text":"Unknown actor 'DoomImp'"}
```

### MCP → engine

`cmd` — a console command to execute:
```json
{"v":1,"t":"cmd","text":"summon DoomImp ; echo __MCPDONE_a1__"}
```

`event` — a raw input event posted via `D_PostEvent` (requires the `event` cap).
Fire-and-forget; the engine sends no reply. Menus read GUI key events
(`evtype=4` EV_GUI_Event, `subtype=1` EV_GUI_KeyDown, `data1=GK_*`):
```json
{"v":1,"t":"event","evtype":4,"subtype":1,"data1":10,"data2":0}
```

`setpause` — set the engine's master pause flag directly (requires the `time`
cap). Fire-and-forget; no reply. `paused` is `1` to pause, `0` to resume.
Single-player Zandronum force-pauses on window-defocus with no cvar to opt out,
so the MCP drives the flag itself to keep a backgrounded instance ticking:
```json
{"v":1,"t":"setpause","paused":0}
```

## Correlation

The bridge is intentionally dumb — it does not match output to commands. The MCP
server appends `; echo <sentinel>` to each command, then collects every `out`
line until it sees the sentinel echoed back. Because console output is a single
shared stream, **commands must be issued serially per instance.**

The bridge's only job: feed `text` to `AddCommandString`, and mirror every
printed line back as an `out` message. Everything else is the server's problem
(which is exactly why almost all of the code — and the tests — live in TS).

On a bridge advertising the `status` cap, the client uses `mcp_status <sentinel>`
as the correlator instead of `echo <sentinel>` — the same sentinel value, but the
CCMD echoes it back as the leading token of a single line also carrying the
engine's state (`<sentinel> paused=0 menu=off console=up gamestate=level
player=alive spectating=0 demo=0 automap=0 chat=0 demorec=0 pending=0
health=100 armor=0`, with `health`/`armor`/`menuclass` present only when there's
a live player actor / an open menu).

| Field | Values | Meaning |
|---|---|---|
| `paused` | `0`, nonzero | the engine's `paused` flag |
| `menu` | `off`, `on`, `waitkey`, `onnopause` | menu state |
| `console` | `up`, `down`, `falling`, `rising` | console state |
| `gamestate` | `level`, `intermission`, `finale`, `demoscreen`, `fullconsole`, `hideconsole`, `startup`, `titlelevel` | game state |
| `player` | `alive`, `dead`, `none` | console player's actor (`none`: no actor) |
| `spectating` | `0`, `1` | console player is spectating |
| `demo` / `demorec` | `0`, `1` | playing back / recording a demo |
| `automap` / `chat` | `0`, `1` | automap open / chat input open |
| `pending` | `0`, `1` | a map, savegame or demo load (`map`, `load`, `playdemo`) is queued for the next tic, so the other fields still describe the state before it. Other queued actions (screenshot, automap toggle, autosave, level exit) don't count |
| `health` / `armor` | integers | console player's health and armor amount |
| `menuclass` | class name | the open menu's class |

That line is excluded from command output
exactly like the plain echo sentinel is, and the client caches its fields as
`lastStatus`. **Without the `status` cap the client always falls back to the
plain `echo` form** — on an
older bridge the sentinel would never come back from `mcp_status`, hanging every
command to its timeout instead of degrading.

The client can also send a bare `mcp_status <sentinel>` with no preceding
command, to refresh `lastStatus` between commands (e.g. after an input-only
tool call that ran no console command). That line is self-correlating and needs
no host command riding alongside it. A probe the engine was too busy to answer
in time (e.g. mid map load) is abandoned; when its line arrives later, inside
another command's output, the client drops it (a line that *starts* with a
sentinel other than the current one). The load tools (`load_map`, `load_game`,
`play_demo`) send such probes until `pending=0`.

The bridge keeps these correlator lines (anything starting with `__MCPDONE_`)
out of the on-screen notify area; the console, logfile and `out` tee still get
them.
