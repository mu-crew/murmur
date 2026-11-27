import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { checkMux } from "../src/cli/doctor.js";
import { diagnose } from "../src/doctor.js";
import {
  chosenPaneTitle,
  PANE_FIELDS,
  PILL_FIELDS,
  parsePaneRow,
  programState,
  readLocal,
  readTmux,
  stateTime,
  localPane as toLocalPane,
} from "../src/local.js";
import { pillValues } from "../src/pill.js";
import { readRex } from "../src/rex.js";
import { openStore, type Store } from "../src/store.js";
import { splitTmuxFields, tmuxText } from "../src/tmux-format.js";
import { DELEGATES_RECORD, type TmuxServer } from "../src/types.js";
import { fakeMux } from "./helpers/fake-mux.js";
import { localPane, ROW_FIELDS, vtmuxMux, vtmuxRow } from "./helpers/panes.js";
import { type FakeBlock, rexWalk } from "./helpers/rex.js";

/**
 * The local collector: one `list-panes -a -F` per tmux server, read into
 * murmur's seven words, plus the Rex reader and the pill.
 *
 * Everything here runs against a fake vtmux. `mux-targets.test.ts` runs the
 * same format against a real private tmux server, which is the check that the
 * spellings themselves are right.
 */

const DEFAULT: TmuxServer = { kind: "default" };
let store: Store;

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-local-"));
  store = openStore();
  return () => store.close();
});

const parse = (fields: Parameters<typeof vtmuxRow>[0]) => parsePaneRow(vtmuxRow(fields), DEFAULT);

// --- the format ------------------------------------------------------------

test("the test helper's column names match the collector's format, one for one", () => {
  // Every other test here builds rows by name; a format that grew a field the
  // helper does not know would shift every column after it.
  expect(ROW_FIELDS).toHaveLength(PANE_FIELDS.length);
  expect(PANE_FIELDS[ROW_FIELDS.indexOf("state")]).toBe("#{pane_program_state}");
  expect(PANE_FIELDS[ROW_FIELDS.indexOf("id")]).toContain("pane_program_id");
  expect(PANE_FIELDS[ROW_FIELDS.indexOf("resume_command")]).toContain("pane_resume_command");
  expect(PANE_FIELDS[ROW_FIELDS.indexOf("mu_agent")]).toContain("@mu_agent");
  expect(PANE_FIELDS[ROW_FIELDS.indexOf("mu_pending")]).toBe(tmuxText("@mu_pending"));
  expect(PANE_FIELDS[ROW_FIELDS.indexOf("dead_status")]).toBe("#{pane_dead_status}");
  expect(PANE_FIELDS[ROW_FIELDS.indexOf("focused")]).toBe(
    "#{&&:#{pane_active},#{&&:#{window_active},#{session_attached}}}",
  );
});

test("the read is ONE list-panes per server, the pill's current values riding along", () => {
  const asked: { fields: readonly string[]; server: TmuxServer }[] = [];
  const mule: TmuxServer = { kind: "label", value: "mule" };
  const mux = fakeMux({
    servers: () => [{ kind: "default" }, mule],
    listPanes: (fields, server) => {
      asked.push({ fields, server });
      return [];
    },
  });
  readTmux(mux, [mule, { kind: "rex" }]);
  expect(asked.map((entry) => entry.server)).toEqual([DEFAULT, mule]);
  for (const entry of asked) expect(entry.fields).toEqual([...PANE_FIELDS, ...PILL_FIELDS]);
});

// --- the seven words ---------------------------------------------------------

test.each([
  ["working", "", "running"],
  ["working", DELEGATES_RECORD, "waiting"],
  ["working", "cargo", "running"],
  ["blocked", "", "blocked"],
  ["error", "", "error"],
  ["done", "", "done"],
  ["idle", "", "idle"],
  ["", "", "idle"],
  ["thinking", "", "idle"],
])("OSC 7501 %j (id %j) reads as %s", (state, id, expected) => {
  // An unknown word reads as `idle`, as the protocol says to.
  expect(programState({ dead: false, deadStatus: null, state, id: id || null })).toBe(expected);
});

test("a retained pane that died non-zero is crashed, whatever its last record said", () => {
  for (const state of ["working", "done", "idle", ""]) {
    expect(programState({ dead: true, deadStatus: "137", state, id: null })).toBe("crashed");
  }
  // Exit 0 is a program that finished: its record stands.
  expect(programState({ dead: true, deadStatus: "0", state: "done", id: null })).toBe("done");
});

test("mu/delegates under working is the agent waiting, with its delegate count", () => {
  const pane = parse({
    state: "working",
    id: DELEGATES_RECORD,
    message: "waiting on 3 delegates",
  });
  expect(pane).toMatchObject({ state: "waiting", pending: 3 });
  // Without a count in the message, one delegate is out.
  expect(parse({ state: "working", id: DELEGATES_RECORD })).toMatchObject({ pending: 1 });
  // Pending is only a waiting pane's: a working one has none recorded.
  expect(parse({ state: "working" })).toMatchObject({ state: "running", pending: null });
});

test("@mu_pending counts delegates beside a running agent, only while working and alive", () => {
  expect(parse({ state: "working", mu_pending: "3" })).toMatchObject({
    state: "running",
    pending: 3,
  });
  // It beats the winning record's own count.
  expect(
    parse({
      state: "working",
      id: DELEGATES_RECORD,
      message: "waiting on 1 delegate",
      mu_pending: "4",
    }),
  ).toMatchObject({ state: "waiting", pending: 4 });
  // A stale option is ignored unless the OSC 7501 state is working.
  for (const state of ["idle", "done", "blocked", "error", ""]) {
    expect(parse({ state, mu_agent: "w-1", mu_pending: "3" })?.pending).toBeNull();
  }
  // ... and on a dead pane.
  expect(
    parse({ state: "working", dead: "1", dead_status: "0", mu_pending: "3" })?.pending,
  ).toBeNull();
  // Zero, junk and unset (older mu, vanilla tmux, empty expansion) change nothing.
  for (const bad of ["0", "-1", "x", "2.5", "3 ", ""]) {
    expect(parse({ state: "working", mu_pending: bad })?.pending).toBeNull();
  }
  // Above MAX_SAFE_INTEGER is ignored.
  expect(parse({ state: "working", mu_pending: "9007199254740993" })?.pending).toBeNull();
  expect(
    parse({
      state: "working",
      id: DELEGATES_RECORD,
      message: "waiting on 2 delegates",
      mu_pending: "0",
    })?.pending,
  ).toBe(2);
});

test("a `|` in @mu_pending cannot shift the row's columns", () => {
  const row = vtmuxRow({ state: "working", mu_pending: "1~199", pill_crashed: "5" });
  const wire = splitTmuxFields(row.join("|"));
  expect(wire).toHaveLength(row.length);
  expect(wire[ROW_FIELDS.indexOf("mu_pending")]).toBe("1|99");
  const parsed = parsePaneRow(wire, DEFAULT);
  expect(parsed?.pending).toBeNull();
});

test("a blocked pane carries its kind; any other state carries none", () => {
  expect(parse({ state: "blocked", kind: "permission" })?.blocked_kind).toBe("permission");
  expect(parse({ state: "blocked", kind: "question" })?.blocked_kind).toBe("question");
  expect(parse({ state: "blocked", kind: "auth" })?.blocked_kind).toBe("auth");
  expect(parse({ state: "blocked", kind: "coffee" })?.blocked_kind).toBeNull();
  expect(parse({ state: "working", kind: "permission" })?.blocked_kind).toBeNull();
});

// --- which panes are listed -------------------------------------------------

test("a pane with neither a program record nor a crew tag is not listed", () => {
  expect(parse({ command: "zsh" })).toBeNull();
  expect(parse({ state: "idle" })).not.toBeNull();
  // A crew pane is listed whatever its program says, so a dead one is never missed.
  expect(parse({ mu_agent: "w-1" })).toMatchObject({ state: "idle", driver: "orchestrated" });
  expect(parse({ mu_agent: "w-1", dead: "1", dead_status: "2" })).toMatchObject({
    state: "crashed",
    dead_status: "2",
  });
});

// --- @mu_* crew tags ---------------------------------------------------------

test("mu's @mu_* pane options name the crew agent and make it orchestrated", () => {
  expect(
    parse({
      state: "working",
      mu_agent: "reviewer-2",
      mu_workstream: "crew-osc7501",
      mu_role: "reviewer",
      mu_host: "linuxpc",
    }),
  ).toMatchObject({
    agent_name: "reviewer-2",
    workstream: "crew-osc7501",
    role: "reviewer",
    driver: "orchestrated",
    runs_on: "linuxpc",
  });
  // No @mu_agent: a pane a person started, however it reports itself.
  expect(parse({ state: "working", mu_workstream: "x" })).toMatchObject({
    agent_name: null,
    driver: "human",
  });
});

// --- the program's own words, and OSC 7577 --------------------------------------

test("the program's own words and its resume record pass through untouched", () => {
  expect(
    parse({
      state: "working",
      app: "claude",
      title: "editing",
      message: "3 files",
      progress: "40",
      resume_command: "claude --resume 0b5c",
      resume_cwd: "/work",
      path: "/work/sub",
      command: "node",
    }),
  ).toMatchObject({
    harness: "claude",
    title: "editing",
    message: "3 files",
    progress: 40,
    resume_command: "claude --resume 0b5c",
    resume_cwd: "/work",
    cwd: "/work/sub",
    cli: "node",
  });
  // A progress that is not 0..100 is not one.
  expect(parse({ state: "working", progress: "140" })?.progress).toBeNull();
  expect(parse({ state: "working", progress: "x" })?.progress).toBeNull();
  expect(parse({ state: "working" })).toMatchObject({ resume_command: null, resume_cwd: null });
});

test("state time is read in seconds or milliseconds, and nonsense is no time", () => {
  expect(stateTime("1764172800")).toBe(1_764_172_800_000);
  expect(stateTime("1764172800123")).toBe(1_764_172_800_123);
  expect(stateTime("")).toBeNull();
  expect(stateTime("0")).toBeNull();
  expect(stateTime("-5")).toBeNull();
});

test("tmux's default pane title (the host name) is no title", () => {
  expect(chosenPaneTitle("box.example.com", "box.example.com")).toBeNull();
  expect(chosenPaneTitle("box", "box.example.com")).toBeNull();
  expect(chosenPaneTitle("Fix auth", "box.example.com")).toBe("Fix auth");
  expect(chosenPaneTitle("", "box")).toBeNull();
});

test("a rex-feed pane (app=murmur) is murmur's own echo, never listed", () => {
  expect(parse({ state: "error", app: "murmur" })).toBeNull();
  expect(parse({ state: "error", app: "pi" })).not.toBeNull();
});

test("focus is the active pane of the active window of an attached session", () => {
  expect(parse({ state: "done", focused: "1" })?.focused).toBe(true);
  expect(parse({ state: "done", focused: "0" })?.focused).toBe(false);
});

// --- attention, as the readers see it ----------------------------------------

test("done, blocked, error and crashed are attention; the rest are activity", () => {
  const as = (state: string, extra: Parameters<typeof vtmuxRow>[0] = {}) => {
    const pane = parse({ state, ...extra });
    if (!pane) throw new Error("not listed");
    return toLocalPane(pane, 7_000);
  };
  expect(as("working").attention).toEqual([]);
  expect(as("working").agent?.activity).toBe("running");
  expect(as("idle").attention).toEqual([]);
  expect(as("done", { message: "PR opened", app: "pi" }).attention).toEqual([
    { kind: "done", message: "PR opened", source: "pi", driver: "human", requested_at: 7_000 },
  ]);
  expect(as("blocked", { kind: "permission" }).attention[0]).toMatchObject({
    kind: "blocked",
    message: "needs permission",
  });
  expect(as("", { mu_agent: "w", dead: "1", dead_status: "3" }).attention[0]).toMatchObject({
    kind: "crashed",
    message: "exited 3",
    driver: "orchestrated",
  });
});

// --- the whole read --------------------------------------------------------------

test("readLocal merges every server, Rex, and the crashes murmur recorded", async () => {
  const rex = { kind: "rex" } as const;
  const mux = vtmuxMux([vtmuxRow({ pane: "%1", state: "working" })]);
  const rexPane = parse({ pane: "%9", state: "done" });
  if (!rexPane) throw new Error("not listed");
  store.recordCrash({
    server: { kind: "label", value: "gone" },
    pane: "%5" as never,
    session: "$1" as never,
    window: "@1" as never,
    session_name: null,
    window_name: null,
  });

  const read = await readLocal(store, mux, 5_000, {
    rex: async () => ({ server: rex, panes: [{ ...rexPane, server: rex }], live: new Set(["%9"]) }),
  });

  expect(read.panes.map((pane) => [pane.server.kind, pane.pane])).toEqual([
    ["default", "%1"],
    ["rex", "%9"],
    ["label", "%5"],
  ]);
  expect(read.tmux.map((entry) => entry.server)).toEqual([DEFAULT]);
});

test("a pane in a linked window is listed once, focused if any session shows it", () => {
  // `list-panes -a` prints a pane once per session its window is linked into.
  const mux = vtmuxMux([
    vtmuxRow({ pane: "%1", session: "$0", state: "working", focused: "0" }),
    vtmuxRow({ pane: "%1", session: "$1", state: "working", focused: "1" }),
    vtmuxRow({ pane: "%2", state: "done" }),
  ]);
  const [read] = readTmux(mux);
  expect(read?.panes?.map((pane) => [pane.pane, pane.focused])).toEqual([
    ["%1", true],
    ["%2", false],
  ]);
});

test("a pane that clears its record is not a crash; one that leaves the server is", async () => {
  const rows = [
    vtmuxRow({ pane: "%1", state: "working" }),
    vtmuxRow({ pane: "%2", state: "blocked" }),
  ];
  const mux = vtmuxMux(rows);
  await readLocal(store, mux, 1_000, { rex: false });
  // %1 sent `state=clear` and is still there; %2 is gone.
  rows.splice(0, 2, vtmuxRow({ pane: "%1", command: "zsh" }));
  const read = await readLocal(store, mux, 2_000, { rex: false });
  expect(read.crashed).toEqual(["%2"]);
  expect(read.panes.map((pane) => pane.pane)).toEqual(["%2"]);
});

test("a retained pane that exits non-zero mid-work is a crash, unlisted or not", async () => {
  const rows = [vtmuxRow({ pane: "%1", state: "working", command: "node" })];
  const mux = vtmuxMux(rows);
  await readLocal(store, mux, 1_000, { rex: false });
  // remain-on-exit keeps %1; vtmux pruned its record, and a dead `node` is no harness.
  rows.splice(0, 1, vtmuxRow({ pane: "%1", command: "node", dead: "1", dead_status: "1" }));
  const read = await readLocal(store, mux, 2_000, { rex: false });
  expect(read.crashed).toEqual(["%1"]);
});

test("a retained pane that exits zero mid-work finished, no crash", async () => {
  const rows = [vtmuxRow({ pane: "%1", state: "working", command: "node" })];
  const mux = vtmuxMux(rows);
  await readLocal(store, mux, 1_000, { rex: false });
  rows.splice(0, 1, vtmuxRow({ pane: "%1", command: "node", dead: "1", dead_status: "0" }));
  expect((await readLocal(store, mux, 2_000, { rex: false })).crashed).toEqual([]);
});

test("a live pane is never also a recorded crash, whatever a racing collect wrote", async () => {
  const mux = vtmuxMux([vtmuxRow({ pane: "%1", state: "working" })]);
  // Another collect records %1 crashed between this one's sync and its read-back.
  const racing: Store = {
    ...store,
    syncLocal(reads, now) {
      const sync = store.syncLocal(reads, now);
      store.recordCrash({
        server: DEFAULT,
        pane: "%1" as never,
        session: "$0" as never,
        window: "@0" as never,
        session_name: null,
        window_name: null,
      });
      return sync;
    },
  };
  const read = await readLocal(racing, mux, 1_000, { rex: false });
  expect(read.panes.map((pane) => pane.pane)).toEqual(["%1"]);
});

test("a Rex reader that fails is no Rex, never an error and never a crash", async () => {
  const rex = { kind: "rex" } as const;
  const pane = parse({ pane: "block:1", state: "working" });
  if (!pane) throw new Error("not listed");
  const mux = vtmuxMux([]);
  await readLocal(store, mux, 1_000, {
    rex: async () => ({
      server: rex,
      panes: [{ ...pane, server: rex }],
      live: new Set(["block:1"]),
    }),
  });
  const read = await readLocal(store, mux, 2_000, {
    rex: async () => {
      throw new Error("rex: connection refused");
    },
  });
  expect(read.panes).toEqual([]);
  expect(read.crashed).toEqual([]);
});

// --- Rex ------------------------------------------------------------------------

/** A fake `rex do` walk over one session, `work`, holding `blocks`. */
function rexApi(blocks: Record<string, FakeBlock>) {
  return rexWalk([
    { session_id: "s-1", label: "work", blocks },
    { label: "no id", blocks: {} },
  ]);
}

test("Rex blocks read into the same shape as tmux panes", async () => {
  const { call } = rexApi({
    "block:a": {
      status: {
        records: [
          {
            id: "",
            state: "working",
            app: "pi",
            title: "editing",
            updated_at: "2026-11-26T10:00:00Z",
          },
          { id: "cargo", state: "error", app: "cargo", msg: "build failed" },
        ],
      },
      process: { child: { argv0: "/usr/bin/node", cwd: "/work" } },
      label: "Fix auth",
    },
    "block:b": {
      status: { records: [{ id: DELEGATES_RECORD, state: "working", msg: "waiting on 2" }] },
      process: { child: { name: "pi" } },
    },
    "block:c": {
      status: { records: [{ state: "blocked", kind: "permission", effective_app: "claude" }] },
      process: { child: {} },
    },
    // A shell with no record is not an agent.
    "block:d": { status: { records: [] }, process: { child: { name: "zsh" } } },
  });

  const read = await readRex(call);
  expect(read?.server).toEqual({ kind: "rex" });
  const byPane = Object.fromEntries((read?.panes ?? []).map((pane) => [pane.pane, pane]));
  expect(Object.keys(byPane).sort()).toEqual(["block:a", "block:b", "block:c"]);
  // The most urgent record speaks for the block.
  expect(byPane["block:a"]).toMatchObject({
    server: { kind: "rex" },
    session: "s-1",
    window: "w-1",
    session_name: "work",
    state: "error",
    harness: "cargo",
    message: "build failed",
    cli: "node",
    cwd: "/work",
    pane_title: "Fix auth",
    focused: false,
  });
  expect(byPane["block:b"]).toMatchObject({ state: "waiting", pending: 2, cli: "pi" });
  expect(byPane["block:c"]).toMatchObject({
    state: "blocked",
    blocked_kind: "permission",
    harness: "claude",
  });
});

test("a Rex block whose program exited non-zero is crashed", async () => {
  const { call } = rexApi({
    "block:a": {
      status: { records: [{ state: "working", app: "pi" }] },
      process: { last_exit: { exit_code: 1 } },
    },
    "block:b": {
      status: { records: [{ state: "done", app: "pi" }] },
      process: { last_exit: { exit_code: 0 } },
    },
  });
  const read = await readRex(call);
  const byPane = Object.fromEntries((read?.panes ?? []).map((pane) => [pane.pane, pane]));
  expect(byPane["block:a"]).toMatchObject({ state: "crashed", dead_status: "1" });
  expect(byPane["block:b"]).toMatchObject({ state: "done", dead_status: null });
});

test("a Rex block whose status cannot be read makes the read no evidence, not a crash", async () => {
  const ok = { status: { records: [{ state: "working", app: "pi" }] }, process: { child: {} } };
  const { call } = rexApi({ "block:a": ok, "block:b": ok });
  const rex = () => readRex(call);
  await readLocal(store, vtmuxMux([]), 1_000, { rex });

  const { call: failing } = rexApi({ "block:a": ok, "block:b": { status: null, process: null } });
  expect(await readRex(failing)).toBeNull();
  const read = await readLocal(store, vtmuxMux([]), 2_000, { rex: () => readRex(failing) });
  expect(read.crashed).toEqual([]);
});

test("a Rex block that clears its status is not a crash", async () => {
  const blocks = {
    "block:a": { status: { records: [{ state: "working", app: "pi" }] } as unknown, process: {} },
  };
  const { call } = rexApi(blocks);
  await readLocal(store, vtmuxMux([]), 1_000, { rex: () => readRex(call) });
  blocks["block:a"].status = { records: [] };
  const read = await readLocal(store, vtmuxMux([]), 2_000, { rex: () => readRex(call) });
  expect(read.crashed).toEqual([]);
  expect(read.panes).toEqual([]);
});

test("a retained Rex block that exits non-zero mid-work is a crash", async () => {
  const blocks: Record<string, FakeBlock> = {
    "block:human": { status: { records: [{ state: "working", app: "pi" }] }, process: {} },
  };
  const { call } = rexApi(blocks);
  await readLocal(store, vtmuxMux([]), 1_000, { rex: () => readRex(call) });
  // Rex keeps the block on exit and prunes its working record.
  blocks["block:human"] = { status: { records: [] }, process: { last_exit: { exit_code: 1 } } };
  const read = await readLocal(store, vtmuxMux([]), 2_000, { rex: () => readRex(call) });
  expect(read.crashed).toEqual(["block:human"]);
});

test("rex-feed's own records in a Rex block are never read back", async () => {
  const { call } = rexApi({
    "block:feed": {
      status: { records: [{ id: "crew/1", state: "error", app: "murmur" }] },
      process: { child: {} },
    },
  });
  expect((await readRex(call))?.panes).toEqual([]);
});

test("no rex binary, or a Rex that will not answer, is no Rex", async () => {
  expect(await readRex(null)).toBeNull();
  expect(await readRex(async () => null)).toBeNull();
  expect(await readRex(async () => "not json")).toBeNull();
});

// --- the pill --------------------------------------------------------------------

test("the pill counts human panes by state, and crew only where a human is needed", () => {
  const values = pillValues([
    localPane({ agent: { activity: "running" } }),
    localPane({ agent: { activity: "stopped", pending: 2 } }),
    localPane({
      agent: { activity: "stopped" },
      attention: [{ kind: "done", message: "", source: "pi", driver: "human", requested_at: 1 }],
    }),
    localPane({ agent: { driver: "orchestrated", activity: "running" } }),
    localPane({
      agent: { driver: "orchestrated", activity: "stopped" },
      attention: [
        { kind: "blocked", message: "", source: "pi", driver: "orchestrated", requested_at: 1 },
      ],
    }),
  ]);
  expect(values).toEqual({
    crashed: "",
    error: "",
    blocked: "1",
    done: "1",
    working: "1",
    waiting: "1",
    idle: "",
    crew: "2",
  });
});

// --- doctor --------------------------------------------------------------------

test("doctor asks every tmux server and Rex, and names a server as a person types it", async () => {
  const servers: TmuxServer[] = [
    { kind: "default" },
    { kind: "label", value: "mule" },
    { kind: "path", value: "/tmp/x.sock" },
  ];
  const check = await checkMux(
    fakeMux({
      servers: () => servers as never,
      serverInfo: (server) =>
        server.kind === "label"
          ? { vtmux: null, version: "3.8", programStatus: null, programResume: null }
          : server.kind === "path"
            ? null
            : { vtmux: "3.8-rc3", version: "3.8", programStatus: "on", programResume: "on" },
    }),
    async () => null,
  );
  expect(check).toEqual({
    tmux: [
      {
        server: "default",
        info: { vtmux: "3.8-rc3", version: "3.8", programStatus: "on", programResume: "on" },
      },
      {
        server: "-L mule",
        info: { vtmux: null, version: "3.8", programStatus: null, programResume: null },
      },
      { server: "-S /tmp/x.sock", info: null },
    ],
    rex: false,
    untagged: [],
  });
  // And diagnosed: stock tmux on mule is a problem with a remedy.
  const findings = diagnose({ host_id: "H", display_name: "here", peers: [], mux: check }, []);
  expect(findings.map((finding) => [finding.kind, finding.subject])).toEqual([
    ["stock-tmux", "-L mule"],
  ]);

  const withRex = await checkMux(fakeMux(), async () => ({
    server: { kind: "rex" },
    panes: [],
    live: new Set<string>(),
  }));
  expect(withRex).toEqual({ tmux: [], rex: true, untagged: [] });
});

test("parsePaneRow keeps an OSC 7577 pane as idle after vtmux clears done on focus", () => {
  const parsed = parse({
    pane: "%0",
    command: "custom-agent",
    state: "",
    app: "",
    resume_command: "pi --session /tmp/s.jsonl",
    resume_cwd: "/tmp",
  });
  expect(parsed).toMatchObject({
    pane: "%0",
    state: "idle",
    cli: "custom-agent",
    resume_command: "pi --session /tmp/s.jsonl",
  });
  // Without 7501, 7577, or @mu_agent, a plain shell is still omitted.
  expect(parse({ pane: "%1", command: "zsh", state: "" })).toBeNull();
});

test("parsePaneRow lists a fresh idle harness pane with no state, tag or resume", () => {
  for (const command of ["pi", "claude", "codex"]) {
    expect(parse({ pane: "%2", command, state: "" })).toMatchObject({
      state: "idle",
      driver: "human",
      cli: command,
      agent_name: null,
    });
  }
  expect(parse({ pane: "%3", command: "zsh", state: "" })).toBeNull();
});

test("chosenPaneTitle strips pi's 'π - <name> - <dir>' wrapper", () => {
  expect(chosenPaneTitle("π - OSC 7501 Rollout - crew", "macbook")).toBe("OSC 7501 Rollout");
  expect(chosenPaneTitle("π - crew", "macbook")).toBe("crew");
  expect(chosenPaneTitle("macbook.local", "macbook.local")).toBeNull();
  expect(chosenPaneTitle("macbook", "macbook.local")).toBeNull();
  expect(chosenPaneTitle("plain title", "macbook")).toBe("plain title");
});
