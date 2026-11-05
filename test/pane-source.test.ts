import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { drainInbox, type InboxHost, writeInboxEvent } from "../src/inbox.js";
import type { InboxEvent } from "../src/inbox-event.js";
import { dbPath } from "../src/paths.js";
import { openStore, type Store } from "../src/store.js";
import type { AgentMeta, Location } from "../src/types.js";
import { builtArtifact } from "./helpers/built.js";
import { fakeMux } from "./helpers/fake-mux.js";

/**
 * pi keeps its pane: the `source` rule between pi's in-process claim and the
 * inbox drain.
 *
 * pi replaces an `inbox` incumbent unless that owner is alive AND pi's
 * ancestor. The first half lets pi win its pane back from a stray inbox claim
 * (its `/new` release window, a store reset); the second keeps the store's
 * nested-agent defence, so a pi run inside a live claude stays silent. Either
 * way pi's replace keeps the incumbent's attention rows.
 */

const SERVER = 6100;
const ROOT = 6200;
const CLAUDE = 6300;
const PI = 6400;

const stores: Store[] = [];
const children: ChildProcess[] = [];

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-source-"));
});

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // Already closed by the test.
    }
  }
  for (const child of children.splice(0)) child.kill();
});

function store(): Store {
  const opened = openStore();
  stores.push(opened);
  return opened;
}

const LOCATION: Location = {
  server: { kind: "default" },
  session: asSessionId("$0"),
  window: asWindowId("@0"),
  pane: asPaneId("%1"),
  session_name: "work",
  window_name: null,
};

const PI_META: AgentMeta = {
  agent_name: null,
  pi_session: "01JQ",
  workstream: null,
  role: null,
  cli: "pi",
  driver: "human",
};

function hookEvent(over: Partial<InboxEvent>): InboxEvent {
  return {
    v: 1,
    event: "prompt_submitted",
    harness: "claude",
    at: 1_000,
    server_pid: SERVER,
    root_pid: ROOT,
    owner_pid: CLAUDE,
    tmux: null,
    tmux_pane: null,
    session_id: "s1",
    source: null,
    reason: null,
    message: null,
    text: null,
    generation_id: null,
    by: "harness",
    agent: { agent_name: null, workstream: null, role: null, cli: null, driver: "human" },
    ...over,
  };
}

/**
 * An inbox claim by "claude" on the pane, with a blocked request and a done,
 * as the drain applies them. `piRuns` is false: this is the stray claim the
 * pi-tree check missed (pi had released its row, or the store was reset).
 */
function strayInboxClaim(s: Store, owner = CLAUDE): void {
  for (const over of [
    { event: "prompt_submitted", owner_pid: owner },
    { event: "turn_stopped", text: "hi", owner_pid: owner },
    { event: "permission_requested", message: "Bash", owner_pid: owner },
  ] as const) {
    expect(writeInboxEvent(hookEvent(over))).toBe(true);
  }
  const host: InboxHost = {
    isAlive: () => true,
    serverFor: () => ({ kind: "default" }),
    panes: () => new Map([[ROOT, { location: LOCATION, focused: false }]]),
    piRunsUnder: () => false,
  };
  expect(drainInbox(s, { host, mux: fakeMux() })).toMatchObject({ applied: 3 });
  expect(s.harnessState(LOCATION)?.source).toBe("inbox");
}

function attentionKinds(s: Store): string[] {
  return (s.localPanes()[0]?.attention ?? []).map((row) => `${row.kind}:${row.source}`).sort();
}

test("pi re-claims its pane after an inbox claim made during its /new window, keeping attention", () => {
  const s = store();
  const first = s.claimAgent({ location: LOCATION, owner_pid: PI, meta: PI_META });
  expect(first.outcome).toBe("claimed");
  // `/new`: session_shutdown releases the row, session_start claims again.
  if (first.outcome !== "claimed") return;
  s.releaseAgent({ agent_id: first.agent_id, owner_pid: PI, location: LOCATION });
  strayInboxClaim(s);
  const before = attentionKinds(s);
  expect(before).toEqual(["blocked:claude", "done:claude"]);

  // The stray owner is alive, but it is not pi's ancestor: pi takes the pane.
  const again = s.claimAgent({
    location: LOCATION,
    owner_pid: PI,
    meta: PI_META,
    isAlive: () => true,
    isAncestor: () => false,
  });
  expect(again.outcome).toBe("replaced");
  expect(s.harnessState(LOCATION)).toMatchObject({ source: "pi", harness: "pi" });
  expect(attentionKinds(s)).toEqual(before);
});

test("pi re-claims its pane after a store reset and an inbox claim, keeping attention", () => {
  const s = store();
  const first = s.claimAgent({ location: LOCATION, owner_pid: PI, meta: PI_META });
  if (first.outcome !== "claimed") throw new Error(first.outcome);
  s.close();
  // A schema change resets the store: every agent row goes, pi's included.
  const database = new Database(dbPath());
  database.pragma("user_version = 9");
  database.close();
  const reset = store();
  expect(reset.localPanes()).toEqual([]);

  strayInboxClaim(reset);
  const before = attentionKinds(reset);

  // pi's next report finds its row gone and claims again, as the extension does.
  expect(
    reset.setActivity({
      agent_id: first.agent_id,
      owner_pid: PI,
      activity: "running",
      location: LOCATION,
    }),
  ).toBe(false);
  // The stray owner has since exited.
  const again = reset.claimAgent({
    location: LOCATION,
    owner_pid: PI,
    meta: PI_META,
    isAlive: () => false,
    isAncestor: () => true,
  });
  expect(again.outcome).toBe("replaced");
  expect(reset.harnessState(LOCATION)?.source).toBe("pi");
  expect(attentionKinds(reset)).toEqual(before);
});

test("a pi nested under a live claude is refused, and claude's attention survives", () => {
  const s = store();
  strayInboxClaim(s);
  const before = attentionKinds(s);
  const nested = s.claimAgent({
    location: LOCATION,
    owner_pid: PI,
    meta: PI_META,
    isAlive: () => true,
    isAncestor: (pid) => pid === CLAUDE,
  });
  expect(nested).toEqual({ outcome: "refused", held_by_pid: CLAUDE });
  expect(s.harnessState(LOCATION)).toMatchObject({ source: "inbox", harness: "claude" });
  expect(attentionKinds(s)).toEqual(before);
});

test("a pi nested under a claude whose events are not drained yet is refused; claude then claims", () => {
  // claude has written events, but no reader has drained, so it has no row.
  const s = store();
  for (const over of [
    { event: "session_start", source: "startup", at: 1 },
    { event: "prompt_submitted", at: 2 },
  ] as const) {
    expect(writeInboxEvent(hookEvent(over))).toBe(true);
  }
  const nested = s.claimAgent({
    location: LOCATION,
    owner_pid: PI,
    meta: PI_META,
    nestedUnder: () => CLAUDE,
  });
  expect(nested).toEqual({ outcome: "refused", held_by_pid: CLAUDE });
  expect(s.localPanes()).toEqual([]);

  // The pi runs under claude, so it does not stop claude's own claim.
  const host: InboxHost = {
    isAlive: () => true,
    serverFor: () => ({ kind: "default" }),
    panes: () => new Map([[ROOT, { location: LOCATION, focused: false }]]),
    piRunsUnder: (_root, except) => except !== CLAUDE,
  };
  expect(drainInbox(s, { host, mux: fakeMux() })).toMatchObject({ applied: 2 });
  expect(s.harnessState(LOCATION)).toMatchObject({ source: "inbox", harness: "claude" });
});

test("the default nesting check walks the real process table to $TMUX's server", () => {
  // A "claude" (node under that name) runs a node child that claims as itself,
  // with $TMUX naming this test process as its server: the walk meets claude
  // first. Under a plain node parent the same claim succeeds.
  const work = mkdtempSync(join(tmpdir(), "murmur-nest-"));
  symlinkSync(process.execPath, join(work, "claude"));
  symlinkSync(process.execPath, join(work, "shell"));
  writeFileSync(
    join(work, "parent.mjs"),
    `import { execFileSync } from "node:child_process";
     process.stdout.write(execFileSync(process.argv[2], [process.argv[3]], { encoding: "utf8" }));`,
  );
  writeFileSync(
    join(work, "pi.mjs"),
    `const { openStore } = await import(${JSON.stringify(builtArtifact("index.js"))});
     const location = ${JSON.stringify(LOCATION)};
     const meta = ${JSON.stringify(PI_META)};
     const result = openStore().claimAgent({ location, owner_pid: process.pid, meta });
     process.stdout.write(result.outcome + ":" + (result.held_by_pid ?? ""));`,
  );
  const run = (parent: string, stateDir: string) =>
    execFileSync(
      join(work, parent),
      [join(work, "parent.mjs"), process.execPath, join(work, "pi.mjs")],
      {
        encoding: "utf8",
        env: { ...process.env, MURMUR_STATE_DIR: stateDir, TMUX: `/tmp/none,${process.pid},0` },
      },
    );

  const nested = run("claude", mkdtempSync(join(tmpdir(), "murmur-source-")));
  expect(nested).toMatch(/^refused:\d+$/);
  expect(run("shell", mkdtempSync(join(tmpdir(), "murmur-source-")))).toBe("claimed:");
});

test("the default ancestry check reads the real process table", () => {
  // This process's parent is alive and is its ancestor: a pi claiming as this
  // process is nested under it, and is refused with no injected check.
  const nested = store();
  strayInboxClaim(nested, process.ppid);
  expect(
    nested.claimAgent({ location: LOCATION, owner_pid: process.pid, meta: PI_META }).outcome,
  ).toBe("refused");
  nested.close();

  // A live process that is NOT an ancestor: pi takes the pane back.
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-source-"));
  const sibling = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    stdio: "ignore",
  });
  children.push(sibling);
  const free = store();
  strayInboxClaim(free, sibling.pid as number);
  expect(
    free.claimAgent({ location: LOCATION, owner_pid: process.pid, meta: PI_META }).outcome,
  ).toBe("replaced");
  expect(attentionKinds(free)).toEqual(["blocked:claude", "done:claude"]);
});

test("a dead pi incumbent is still replaced the old way, attention and all", () => {
  // Unchanged pi behaviour: a dead pi's attention described a process that is
  // gone. Only an inbox incumbent's attention is kept.
  const s = store();
  s.claimAgent({ location: LOCATION, owner_pid: PI, meta: PI_META });
  s.requestAttention({
    kind: "done",
    location: LOCATION,
    message: "",
    source: "pi",
    driver: "human",
  });
  const next = s.claimAgent({
    location: LOCATION,
    owner_pid: PI + 1,
    meta: PI_META,
    isAlive: () => false,
  });
  expect(next.outcome).toBe("replaced");
  expect(attentionKinds(s)).toEqual([]);
});
