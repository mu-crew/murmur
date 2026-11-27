import { expect, test } from "vitest";
import { readRex, shellCommand } from "../src/rex.js";
import { rexWalk } from "./helpers/rex.js";

/**
 * The Rex reader's full fidelity: one `rex do` walk read into window names,
 * pane titles, OSC 7577 resume records, mu identity and host. Driven through
 * the `RexCall` seam, so no Rex server is needed.
 */

const working = { records: [{ state: "working", app: "pi" }] };
const quiet = { records: {} };

test("the whole read is one rex fork", async () => {
  const { call, calls } = rexWalk([
    { session_id: "s-1", label: "a", blocks: { "block:a": { status: working, process: {} } } },
    { session_id: "s-2", label: "b", blocks: { "block:b": { status: working, process: {} } } },
  ]);
  const read = await readRex(call);
  expect(read?.panes.map((pane) => pane.pane).sort()).toEqual(["block:a", "block:b"]);
  expect(calls).toHaveLength(1);
});

test("an empty Rex, with Lua's `{}` for every empty list, is an empty read", async () => {
  const { call } = rexWalk([]);
  const read = await readRex(call);
  expect(read?.panes).toEqual([]);
  expect(read?.live.size).toBe(0);
});

test("window names skip Rex's own labels; pane titles fall back from label to title", async () => {
  const { call } = rexWalk([
    {
      session_id: "s-1",
      label: "work",
      windows: [
        { window_id: "w-1", label: "Window ff648844" },
        { window_id: "w-2", label: "editor" },
      ],
      blocks: {
        "block:a": { status: working, process: {}, label: "Fix auth", window: "w-1" },
        "block:b": {
          status: working,
          process: {},
          label: "shell",
          window: "w-2",
          title: { ok: { title: "π - review - repo" } },
        },
        "block:c": {
          status: working,
          process: {},
          label: "shell",
          title: { err: "method not found (code=method_not_found)", code: "method_not_found" },
        },
      },
    },
  ]);
  const byPane = Object.fromEntries(((await readRex(call))?.panes ?? []).map((p) => [p.pane, p]));
  expect(byPane["block:a"]).toMatchObject({ window_name: null, pane_title: "Fix auth" });
  expect(byPane["block:b"]).toMatchObject({ window_name: "editor", pane_title: "review" });
  expect(byPane["block:c"]).toMatchObject({ pane_title: null, focused: false });
});

test("a live OSC 7577 record lists an idle pane, quoted as vtmux quotes it", async () => {
  const { call } = rexWalk([
    {
      session_id: "s-1",
      label: "work",
      blocks: {
        "block:a": {
          status: quiet,
          process: { foreground: { name: "pi" } },
          resume: {
            ok: {
              records: [
                { chosen: false, command: ["old"], reported_at: "2026-11-27T10:00:00Z" },
                {
                  chosen: true,
                  command: ["pi", "--session", "it's a/b.jsonl"],
                  cwd: "/work",
                  reported_at: "2026-11-27T09:00:00Z",
                },
              ],
            },
          },
        },
        // Rex prunes a record once its owner exits: a plain shell drops off.
        "block:b": { status: quiet, process: {}, resume: { ok: { records: {} } } },
      },
    },
  ]);
  const read = await readRex(call);
  expect(read?.panes).toHaveLength(1);
  expect(read?.panes[0]).toMatchObject({
    pane: "block:a",
    state: "idle",
    resume_command: "pi --session 'it'\\''s a/b.jsonl'",
    resume_cwd: "/work",
  });
  expect(read?.live).toEqual(new Set(["block:a", "block:b"]));
});

test("without a chosen record, the latest one speaks", async () => {
  const { call } = rexWalk([
    {
      session_id: "s-1",
      label: "work",
      blocks: {
        "block:a": {
          status: quiet,
          process: {},
          resume: {
            ok: {
              records: [
                { command: ["/bin/new"], reported_at: "2026-11-27T10:00:00Z" },
                { command: ["/bin/old"], reported_at: "2026-11-27T09:00:00Z" },
              ],
            },
          },
        },
      },
    },
  ]);
  expect((await readRex(call))?.panes[0]?.resume_command).toBe("/bin/new");
});

test("shell quoting matches vtmux's shell_command", () => {
  expect(shellCommand(["claude", "--resume", "abc-123"])).toBe("claude --resume abc-123");
  expect(shellCommand(["a b", "", "$x", "k=v"])).toBe("'a b' '' '$x' 'k=v'");
  expect(shellCommand(["do", "do"])).toBe("'do' do");
});

test("an older Rex without program_resume_records still reads", async () => {
  const { call } = rexWalk([
    {
      session_id: "s-1",
      label: "work",
      blocks: {
        "block:a": {
          status: working,
          process: {},
          resume: { err: "method not found (code=method_not_found)", code: "method_not_found" },
        },
      },
    },
  ]);
  expect((await readRex(call))?.panes[0]).toMatchObject({ state: "running", resume_command: null });
});

test("a resume or title reply that fails otherwise makes the read no evidence", async () => {
  const failed = { err: "timeout", code: "deadline_exceeded" };
  for (const broken of [{ resume: failed }, { title: failed }]) {
    const { call } = rexWalk([
      {
        session_id: "s-1",
        label: "work",
        blocks: { "block:a": { status: working, process: {}, ...broken } },
      },
    ]);
    expect(await readRex(call)).toBeNull();
  }
});

test("a session that could not be walked makes the read no evidence", async () => {
  const { call } = rexWalk([{ session_id: "s-1", label: "work", blocks: {} }]);
  const unattached = async (script: string) => {
    const reply = (await call(script)) as { walked: { view: unknown }[] };
    const [walked] = reply.walked;
    if (walked) walked.view = { err: "conflict", code: "conflict" };
    return reply;
  };
  expect(await readRex(unattached)).toBeNull();
});

test("a block in mu's session is an orchestrated agent named by its label", async () => {
  const { call } = rexWalk([
    {
      session_id: "s-1",
      label: "mu-crew-rex",
      blocks: {
        "block:a": {
          status: quiet,
          process: {},
          label: "worker-1",
          title: { ok: { title: "π - task - repo" } },
        },
        // mu's `_mu` window is a plain shell, not an agent.
        "block:b": { status: quiet, process: {}, label: "_mu" },
      },
    },
    {
      session_id: "s-2",
      label: "notes",
      blocks: { "block:c": { status: working, process: {}, label: "worker-2" } },
    },
  ]);
  const read = await readRex(call);
  const byPane = Object.fromEntries((read?.panes ?? []).map((p) => [p.pane, p]));
  expect(Object.keys(byPane).sort()).toEqual(["block:a", "block:c"]);
  expect(byPane["block:a"]).toMatchObject({
    agent_name: "worker-1",
    workstream: "crew-rex",
    driver: "orchestrated",
    state: "idle",
    pane_title: "task",
  });
  expect(byPane["block:c"]).toMatchObject({
    agent_name: null,
    workstream: null,
    driver: "human",
    pane_title: "worker-2",
  });
});

test("a block on another host than the server runs there", async () => {
  const { call } = rexWalk([
    {
      session_id: "s-1",
      label: "work",
      blocks: {
        "block:a": { status: working, process: {} },
        "block:b": { status: working, process: {}, host_id: "host-far" },
        "block:c": { status: working, process: {}, host_id: "host-unknown" },
      },
    },
  ]);
  const byPane = Object.fromEntries(((await readRex(call))?.panes ?? []).map((p) => [p.pane, p]));
  expect(byPane["block:a"]?.runs_on).toBeNull();
  expect(byPane["block:b"]?.runs_on).toBe("me@far");
  expect(byPane["block:c"]?.runs_on).toBe("host-unknown");
});

test("a reply that is not the walk is no Rex", async () => {
  expect(await readRex(async () => ({}))).toBeNull();
  expect(await readRex(async () => ({ sessions: { err: "x", code: "unavailable" } }))).toBeNull();
  expect(await readRex(async () => [])).toBeNull();
});
