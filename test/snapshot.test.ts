import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createIdentity } from "../src/identity.js";
import { buildSnapshot, readLocal } from "../src/local.js";
import { parseSnapshot, SnapshotInvalidError } from "../src/snapshot.js";
import { openStore, type Store } from "../src/store.js";
import type { Snapshot, TmuxServer } from "../src/types.js";
import { builtArtifact } from "./helpers/built.js";
import { vtmuxMux, vtmuxRow } from "./helpers/panes.js";

/**
 * The snapshot document, as the ONE thing a node publishes.
 *
 * The claims here are about the document rather than about the tables:
 * everything murmur knows about a node is in it, absence from it is absence,
 * and nothing partially valid can be read back out of one. A reader needs no
 * state of its own to interpret a snapshot, so there is no state for it to hold
 * wrongly.
 *
 * `local.test.ts` owns how a pane is read; this file owns the round trip:
 * read -> build -> serialise -> validate, plus the shipped `murmur export`.
 */

const stores: Store[] = [];

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-snapshot-"));
});

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // Already closed by the test.
    }
  }
});

function store(): Store {
  const opened = openStore();
  stores.push(opened);
  return opened;
}

const IDENTITY = { host_id: "H", display_name: "here" };

/** This node's snapshot, built from one local read of these vtmux rows. */
async function built(s: Store, rows: string[][], now = 42): Promise<Snapshot> {
  const local = await readLocal(s, vtmuxMux(rows), now, { rex: false });
  return buildSnapshot(IDENTITY, local.panes, now);
}

// --- the document round trip ---------------------------------------------

test("a built snapshot validates as one, and survives serialisation unchanged", async () => {
  // The property that makes the two-node case work at all: what this node
  // publishes is exactly what a peer's validator accepts. A build path and a
  // validate path that disagreed would be undetectable locally and would show
  // up as "that host is broken" on every OTHER machine.
  const s = store();
  const document = await built(s, [
    vtmuxRow({
      pane: "%1",
      window: "@1",
      window_name: "worker-1",
      state: "working",
      app: "pi",
      progress: "40",
      title: "editing",
      mu_agent: "worker-1",
      mu_workstream: "murmur",
      mu_role: "implementer",
      resume_command: "pi --session /s/1.jsonl",
      resume_cwd: "/work",
      state_time: "5",
    }),
    vtmuxRow({
      pane: "%2",
      window: "@2",
      state: "blocked",
      kind: "question",
      app: "codex",
      message: "needs input",
      state_time: "7",
    }),
  ]);
  const parsed = parseSnapshot(JSON.stringify(document));

  expect(parsed).toEqual(document);
  expect(parsed.panes.map((pane) => pane.pane)).toEqual(["%1", "%2"]);
  expect(parsed.panes[0]?.agent).toMatchObject({
    activity: "running",
    agent_name: "worker-1",
    workstream: "murmur",
    role: "implementer",
    driver: "orchestrated",
    harness: "pi",
    progress: 40,
    title: "editing",
    resume_command: "pi --session /s/1.jsonl",
    resume_cwd: "/work",
    updated_at: 5_000,
  });
  // A blocked program's request is an attention row carrying its own words.
  expect(parsed.panes[1]).toMatchObject({
    window: "@2",
    agent: { activity: "stopped", blocked_kind: "question", driver: "human" },
    attention: [
      {
        kind: "blocked",
        message: "needs input",
        source: "codex",
        driver: "human",
        requested_at: 7_000,
      },
    ],
  });
});

test("the document carries no local-only fact: focus and runs_on stay home", async () => {
  // A remote node's focus says nothing about this operator, and `@mu_host`
  // names a host from THIS node's point of view. The reader rejects unknown
  // keys, so either leaking would also break every peer at once.
  const document = await built(store(), [
    vtmuxRow({ pane: "%1", state: "working", focused: "1", mu_agent: "w", mu_host: "linuxpc" }),
  ]);
  const text = JSON.stringify(document);
  expect(text).not.toContain("focused");
  expect(text).not.toContain("runs_on");
  expect(text).not.toContain("linuxpc");
  expect(parseSnapshot(text).panes).toHaveLength(1);
});

test("panes are emitted sorted by address, and order carries no meaning", async () => {
  const document = await built(store(), [
    vtmuxRow({ pane: "%3", state: "working" }),
    vtmuxRow({ pane: "%1", state: "idle" }),
    vtmuxRow({ pane: "%2", state: "done" }),
  ]);
  expect(document.panes.map((pane) => pane.pane)).toEqual(["%1", "%2", "%3"]);
});

test("absence from a snapshot is absence: a pane that left is not published", async () => {
  // A pane that finished and closed is simply gone; one that vanished
  // mid-work is published as murmur's own `crashed` row, with the identity it
  // was last seen with, so a peer can still say WHICH agent died.
  const s = store();
  await built(s, [
    vtmuxRow({ pane: "%1", state: "done" }),
    vtmuxRow({ pane: "%2", state: "working", mu_agent: "worker-2" }),
  ]);
  const after = await built(s, [], 50);
  expect(after.panes).toMatchObject([
    {
      pane: "%2",
      agent: { agent_name: "worker-2", driver: "orchestrated", activity: "stopped" },
      attention: [{ kind: "crashed", source: "murmur", requested_at: 50 }],
    },
  ]);
  expect(parseSnapshot(JSON.stringify(after)).panes).toHaveLength(1);
});

test("a pane with nothing to say is a pane nobody mentions, locally or on the wire", async () => {
  // A shell with no OSC 7501 record and no crew tag is not an agent: it is not
  // listed, so the validator's rule 3 can never fire against our own output.
  const document = await built(store(), [
    vtmuxRow({ pane: "%1" }),
    vtmuxRow({ pane: "%2", state: "idle" }),
  ]);
  expect(document.panes.map((pane) => pane.pane)).toEqual(["%2"]);
  expect(parseSnapshot(JSON.stringify(document)).panes).toHaveLength(1);
});

test("a snapshot states its own version and speaks snapshot 8", async () => {
  const document = await built(store(), [], 1);

  expect(document.murmur_snapshot).toBe(8);
  expect(document.murmur_version).toMatch(/^\d+\.\d+\.\d+/);
  // An empty node is a valid, complete document: it says "nothing here", which
  // is a fact, not an absence of one.
  expect(parseSnapshot(JSON.stringify(document)).panes).toEqual([]);
});

// --- validation ----------------------------------------------------------

test.each<[TmuxServer, TmuxServer]>([
  [{ kind: "default" }, { kind: "default" }],
  [
    { kind: "label", value: "mule" },
    { kind: "label", value: "mule" },
  ],
  [
    { kind: "path", value: "/tmp/tmux.sock" },
    { kind: "path", value: "/tmp/tmux.sock" },
  ],
])("server tag %j round-trips exactly", (server, expected) => {
  const document = {
    murmur_snapshot: 8,
    host_id: "H",
    display_name: "d",
    murmur_version: "0.5.0",
    generated_at: 1,
    panes: [
      {
        server,
        pane: "%1",
        session: "$0",
        window: "@1",
        session_name: null,
        window_name: null,
        agent: null,
        attention: [{ kind: "done", message: "", source: "pi", driver: "human", requested_at: 1 }],
      },
    ],
  };

  expect(parseSnapshot(JSON.stringify(document)).panes[0]?.server).toEqual(expected);
});

test.each([
  [
    "default with a value",
    { kind: "default", value: "mule" },
    "panes[0].server",
    "unknown key value",
  ],
  ["empty label", { kind: "label", value: "" }, "panes[0].server.value", "non-empty string"],
  ["label without a value", { kind: "label" }, "panes[0].server", "missing key value"],
  [
    "label with an extra key",
    { kind: "label", value: "mule", extra: true },
    "panes[0].server",
    "unknown key extra",
  ],
  [
    "relative path",
    { kind: "path", value: "tmp/tmux.sock" },
    "panes[0].server.value",
    "absolute path",
  ],
  ["path without a value", { kind: "path" }, "panes[0].server", "missing key value"],
  [
    "unknown kind",
    { kind: "socket", value: "mule" },
    "panes[0].server.kind",
    "default, label, path",
  ],
])("rejects %s with its exact server field path", (_why, server, path, detail) => {
  const document = {
    murmur_snapshot: 8,
    host_id: "H",
    display_name: "d",
    murmur_version: "0.5.0",
    generated_at: 1,
    panes: [
      {
        server,
        pane: "%1",
        session: "$0",
        window: "@1",
        session_name: null,
        window_name: null,
        agent: null,
        attention: [{ kind: "done", message: "", source: "pi", driver: "human", requested_at: 1 }],
      },
    ],
  };

  expect(() => parseSnapshot(JSON.stringify(document))).toThrow(`${path}:`);
  expect(() => parseSnapshot(JSON.stringify(document))).toThrow(detail);
});

test("a pane missing its server tag is rejected at the pane path", () => {
  const document = {
    murmur_snapshot: 8,
    host_id: "H",
    display_name: "d",
    murmur_version: "0.5.0",
    generated_at: 1,
    panes: [
      {
        pane: "%1",
        session: "$0",
        window: "@1",
        session_name: null,
        window_name: null,
        agent: null,
        attention: [{ kind: "done", message: "", source: "pi", driver: "human", requested_at: 1 }],
      },
    ],
  };

  expect(() => parseSnapshot(JSON.stringify(document))).toThrow("panes[0]: missing key server");
});

test("the same pane id is valid on different tmux servers", () => {
  const pane = {
    server: { kind: "default" },
    pane: "%1",
    session: "$0",
    window: "@1",
    session_name: null,
    window_name: null,
    agent: null,
    attention: [{ kind: "done", message: "", source: "pi", driver: "human", requested_at: 1 }],
  };
  const document = {
    murmur_snapshot: 8,
    host_id: "H",
    display_name: "d",
    murmur_version: "0.5.0",
    generated_at: 1,
    panes: [pane, { ...pane, server: { kind: "label", value: "mule" } }],
  };

  expect(parseSnapshot(JSON.stringify(document)).panes).toHaveLength(2);
  expect(() => parseSnapshot(JSON.stringify({ ...document, panes: [pane, pane] }))).toThrow(
    "duplicate pane default:%1",
  );
});

test("snapshot v2 is deliberately incompatible and names both versions", () => {
  expect(() =>
    parseSnapshot(
      JSON.stringify({
        murmur_snapshot: 2,
        host_id: "H",
        display_name: "d",
        murmur_version: "0.4.4",
        generated_at: 1,
        panes: [],
      }),
    ),
  ).toThrow("murmur_snapshot: expected 8, got 2");
});

test("parseSnapshot names the first failing path so an operator can act", () => {
  // The message is the whole diagnostic a remote operator gets: `peer list`
  // shows `last_error` and nothing else. "invalid snapshot" would send them to
  // read code on another machine.
  const bad = JSON.stringify({
    murmur_snapshot: 8,
    host_id: "H",
    display_name: "d",
    murmur_version: "0.1.0",
    generated_at: 1,
    panes: [
      {
        server: { kind: "default" },
        pane: "%1",
        session: "$0",
        window: "@1",
        session_name: null,
        window_name: null,
        agent: null,
        attention: [
          { kind: "working", message: "", source: "x", driver: "human", requested_at: 1 },
        ],
      },
    ],
  });

  expect(() => parseSnapshot(bad)).toThrow(SnapshotInvalidError);
  expect(() => parseSnapshot(bad)).toThrow("panes[0].attention[0].kind");
});

test("nothing is coerced, defaulted or carried through", () => {
  const base = {
    murmur_snapshot: 8,
    host_id: "H",
    display_name: "d",
    murmur_version: "0.1.0",
    generated_at: 1,
    panes: [] as unknown[],
  };
  const pane = {
    server: { kind: "default" },
    pane: "%1",
    session: "$0",
    window: "@1",
    session_name: null,
    window_name: null,
    agent: null,
    attention: [{ kind: "done", message: "", source: "pi", driver: "human", requested_at: 1 }],
  };
  // One process instance, as two panes would report it if a document claimed it.
  const owner = {
    activity: "running",
    agent_name: null,
    workstream: null,
    role: null,
    cli: "pi",
    driver: "human",
    pending: null,
    pane_title: null,
    title: null,
    message: null,
    progress: null,
    blocked_kind: null,
    resume_command: null,
    resume_cwd: null,
    cwd: null,
    updated_at: 1,
  };
  // Each entry is a document a node could plausibly serve, and each names the
  // way a lenient parser would have let it through: a coerced number, a
  // defaulted null, an unknown key kept "just in case".
  const rejected: [why: string, document: unknown][] = [
    // Both directions, because compatibility is offered in neither: a reader
    // that accepted the older document would be guessing at the fields that
    // version added, which are exactly the state a human acts on.
    ["a newer protocol", { ...base, murmur_snapshot: 9 }],
    ["an older protocol", { ...base, murmur_snapshot: 7 }],
    ["a stringly-typed clock", { ...base, generated_at: "1" }],
    ["a fractional clock", { ...base, generated_at: 1.5 }],
    ["a negative clock", { ...base, generated_at: -1 }],
    ["an empty host_id", { ...base, host_id: "" }],
    [
      "a missing murmur_version",
      { murmur_snapshot: 8, host_id: "H", display_name: "d", generated_at: 1, panes: [] },
    ],
    ["an unknown top-level key", { ...base, extra: 3 }],
    ["panes as an object", { ...base, panes: {} }],
    ["a pane missing window_name", { ...base, panes: [{ ...pane, window_name: undefined }] }],
    ["an unknown pane key", { ...base, panes: [{ ...pane, rank: 4 }] }],
    ["an empty pane id", { ...base, panes: [{ ...pane, pane: "" }] }],
    // Snapshot 6 made the attention driver required: a reader defaulting it
    // would count a peer's crew worker as yours, the bug the field exists for.
    [
      "an attention entry missing driver",
      {
        ...base,
        panes: [
          { ...pane, attention: [{ kind: "done", message: "", source: "pi", requested_at: 1 }] },
        ],
      },
    ],
    [
      "an unknown attention driver",
      { ...base, panes: [{ ...pane, attention: [{ ...pane.attention[0], driver: "robot" }] }] },
    ],
    // Every nullable string, each wrong in the same way. `textOrNull` guards six
    // fields and NONE was covered: a sweep made it return `value as string |
    // null` -- accepting a number for all six -- and the suite stayed green.
    ["a numeric session_name", { ...base, panes: [{ ...pane, session_name: 7 }] }],
    ["a numeric window_name", { ...base, panes: [{ ...pane, window_name: 7 }] }],
    ["a numeric agent_name", { ...base, panes: [{ ...pane, agent: { ...owner, agent_name: 7 } }] }],
    [
      "a numeric resume_command",
      { ...base, panes: [{ ...pane, agent: { ...owner, resume_command: 7 } }] },
    ],
    ["a progress over 100", { ...base, panes: [{ ...pane, agent: { ...owner, progress: 101 } }] }],
    [
      "an unknown blocked_kind",
      { ...base, panes: [{ ...pane, agent: { ...owner, blocked_kind: "coffee" } }] },
    ],
    ["a numeric workstream", { ...base, panes: [{ ...pane, agent: { ...owner, workstream: 7 } }] }],
    ["a numeric role", { ...base, panes: [{ ...pane, agent: { ...owner, role: 7 } }] }],
    ["a negative pending", { ...base, panes: [{ ...pane, agent: { ...owner, pending: -1 } }] }],
    ["a fractional pending", { ...base, panes: [{ ...pane, agent: { ...owner, pending: 1.5 } }] }],
    [
      "a missing pending",
      { ...base, panes: [{ ...pane, agent: { ...owner, pending: undefined } }] },
    ],
    ["a duplicate pane", { ...base, panes: [pane, pane] }],
    [
      "a duplicate kind in one pane",
      { ...base, panes: [{ ...pane, attention: [...pane.attention, ...pane.attention] }] },
    ],
    ["a pane with nothing to say", { ...base, panes: [{ ...pane, attention: [] }] }],
    [
      "an agent missing driver",
      {
        ...base,
        panes: [
          {
            ...pane,
            agent: {
              activity: "running",
              agent_name: null,
              workstream: null,
              role: null,
              cli: "pi",
              pane_title: null,
              title: null,
              message: null,
              progress: null,
              blocked_kind: null,
              pending: null,
              resume_command: null,
              resume_cwd: null,
              cwd: null,
              updated_at: 1,
            },
          },
        ],
      },
    ],
  ];

  for (const [why, document] of rejected) {
    expect(() => parseSnapshot(JSON.stringify(document)), why).toThrow(SnapshotInvalidError);
  }
});

test("a document that is not JSON is a snapshot error, not a crash", () => {
  // What an unconfigured host actually answers with: ssh succeeds, the command
  // does not exist, and the "document" is a shell error on stdout.
  expect(() => parseSnapshot("murmur: command not found")).toThrow(SnapshotInvalidError);
  expect(() => parseSnapshot("")).toThrow(SnapshotInvalidError);
  expect(() => parseSnapshot("[]")).toThrow(SnapshotInvalidError);
  expect(() => parseSnapshot("null")).toThrow(SnapshotInvalidError);
});

// --- the shipped command -------------------------------------------------

/** `murmur export` as a peer's ssh would run it: the built CLI, a scratch node. */
function runExport(env: NodeJS.ProcessEnv = {}): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [builtArtifact("cli.js"), "export"], {
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, status: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; status?: number };
    return { stdout: failure.stdout ?? "", status: failure.status ?? 1 };
  }
}

test("murmur export prints exactly one snapshot document and nothing else", () => {
  const dir = process.env.MURMUR_STATE_DIR as string;
  createIdentity("exporter");

  const { stdout, status } = runExport({ MURMUR_STATE_DIR: dir });

  expect(status).toBe(0);
  // One line, one document. A second line would let a reader split on newlines
  // and parse each piece, which is a reader that can act on half a document.
  expect(stdout.trimEnd().split("\n")).toHaveLength(1);
  const parsed: Snapshot = parseSnapshot(stdout);
  expect(parsed).toMatchObject({ murmur_snapshot: 8, display_name: "exporter", panes: [] });
});

test("murmur export takes no options: an unknown flag is rejected, not ignored", () => {
  const dir = process.env.MURMUR_STATE_DIR as string;
  createIdentity("exporter");

  const rejected = (() => {
    try {
      execFileSync(process.execPath, [builtArtifact("cli.js"), "export", "--verbose"], {
        env: { ...process.env, MURMUR_STATE_DIR: dir },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return false;
    } catch {
      return true;
    }
  })();

  // An accepted-and-ignored flag is the dangerous shape: a caller that believes
  // it asked for something narrower would read a full document as though it were
  // the answer to its own question.
  expect(rejected).toBe(true);
});

test("murmur export on an uninitialised node refuses instead of minting a node", () => {
  const dir = process.env.MURMUR_STATE_DIR as string;

  const { stdout, status } = runExport({ MURMUR_STATE_DIR: dir });

  expect(status).toBe(1);
  expect(stdout).toBe("");
});

// --- the program's own fields (snapshot v8) -------------------------------

/** A valid document with one agent pane, its agent fields overridden. */
function agentDocument(agent: Record<string, unknown>): string {
  return JSON.stringify({
    murmur_snapshot: 8,
    host_id: "H",
    display_name: "d",
    murmur_version: "3.0.0",
    generated_at: 1,
    panes: [
      {
        server: { kind: "default" },
        pane: "%1",
        session: "$0",
        window: "@1",
        session_name: null,
        window_name: null,
        agent: {
          activity: "running",
          agent_name: null,
          workstream: null,
          role: null,
          cli: "pi",
          harness: "pi",
          driver: "human",
          pending: null,
          pane_title: null,
          title: null,
          message: null,
          progress: null,
          blocked_kind: null,
          resume_command: null,
          resume_cwd: null,
          cwd: null,
          updated_at: 1,
          ...agent,
        },
        attention: [],
      },
    ],
  });
}

test("an older document is rejected with the version error, whatever it carries", () => {
  // Compatibility is offered in neither direction: a 2.x document carries
  // agent ids and model fields a 3.0 reader would have to guess around.
  for (const version of [2, 6, 7]) {
    const older = agentDocument({}).replace('"murmur_snapshot":8', `"murmur_snapshot":${version}`);
    expect(() => parseSnapshot(older)).toThrow(SnapshotInvalidError);
    expect(() => parseSnapshot(older)).toThrow(`murmur_snapshot: expected 8, got ${version}`);
  }
});

test("the OSC 7501 and 7577 fields round-trip", () => {
  const parsed = parseSnapshot(
    agentDocument({
      activity: "stopped",
      pane_title: "Fix auth",
      title: "reviewing",
      message: "waiting on 2 delegates",
      progress: 0,
      blocked_kind: "permission",
      pending: 2,
      resume_command: "claude --resume 0b5c",
      resume_cwd: "/work",
      cwd: "/work/sub",
    }),
  );
  expect(parsed.panes[0]?.agent).toMatchObject({
    pane_title: "Fix auth",
    title: "reviewing",
    message: "waiting on 2 delegates",
    progress: 0,
    blocked_kind: "permission",
    pending: 2,
    resume_command: "claude --resume 0b5c",
    resume_cwd: "/work",
    cwd: "/work/sub",
  });
});

test("every program field is nullable, and none may be omitted", () => {
  // A program that reports nothing is a valid agent; a node that omits a key
  // is speaking a different document than it claims to.
  expect(parseSnapshot(agentDocument({})).panes[0]?.agent?.resume_command).toBeNull();
  for (const key of [
    "pane_title",
    "title",
    "message",
    "progress",
    "blocked_kind",
    "pending",
    "resume_command",
    "resume_cwd",
    "cwd",
    "harness",
  ]) {
    const missing = JSON.parse(agentDocument({}));
    missing.panes[0].agent[key] = undefined;
    expect(() => parseSnapshot(JSON.stringify(missing)), key).toThrow(`missing key ${key}`);
  }
});

test("a progress outside 0..100, or not a number, is rejected", () => {
  for (const progress of [-1, 101, "40"]) {
    expect(() => parseSnapshot(agentDocument({ progress })), String(progress)).toThrow("progress");
  }
  for (const progress of [0, 100]) {
    expect(parseSnapshot(agentDocument({ progress })).panes[0]?.agent?.progress).toBe(progress);
  }
});

test("the 2.x agent fields are unknown keys now, not ignored ones", () => {
  // An unknown key that survived a hop would let a reader act on something no
  // writer here agreed to.
  for (const key of ["agent_id", "pi_session", "model", "context_pct", "usage", "claimed_at"]) {
    expect(() => parseSnapshot(agentDocument({ [key]: null })), key).toThrow(`unknown key ${key}`);
  }
});
