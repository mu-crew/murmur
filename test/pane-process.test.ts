import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { checkMux } from "../src/cli/doctor.js";
import { diagnose } from "../src/doctor.js";
import { readLocal } from "../src/local.js";
import {
  argvHarness,
  type PaneProcess,
  parsePsEnvironment,
  readPaneProcess,
} from "../src/pane-process.js";
import { localStatus, statusJson } from "../src/status.js";
import { openStore, type Store } from "../src/store.js";
import { vtmuxMux, vtmuxRow } from "./helpers/panes.js";

/**
 * The identity fallback for a pane mu placed but did not tag: its root
 * process's environment, read once per (pane, pid) and cached in the store.
 */

let store: Store;
const savedPath = process.env.PATH;

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-pane-process-"));
  store = openStore();
});

afterEach(() => {
  store.close();
  process.env.PATH = savedPath;
});

const WORKER: PaneProcess = {
  managed: true,
  agent_name: "x",
  workstream: "crew",
  orchestrator: false,
  harness: "pi",
};

/** A Mux answering these rows, counting every process read. */
function muxWith(rows: string[][], answer: (pid: string) => PaneProcess | null) {
  const reads: string[] = [];
  const mux = vtmuxMux(rows, {
    paneProcess: (pid) => {
      reads.push(pid);
      return answer(pid);
    },
  });
  return { mux, reads };
}

test("an untagged pane whose env says mu placed it reads as orchestrated, by name", async () => {
  const { mux } = muxWith([vtmuxRow({ pane: "%1", pid: "41", state: "working" })], () => WORKER);
  const view = await localStatus(store, { host_id: "LOCAL", display_name: "here" }, 1_000, {
    mux,
    rex: false,
  });
  const [pane] = statusJson(view).panes;
  expect(pane).toMatchObject({
    driver: "orchestrated",
    agent_name: "x",
    workstream: "crew",
    role: "worker",
  });
});

test("MU_ORCHESTRATOR makes the env role orchestrator", async () => {
  const { mux } = muxWith([vtmuxRow({ pane: "%1", state: "working" })], () => ({
    ...WORKER,
    orchestrator: true,
  }));
  const read = await readLocal(store, mux, 1_000, { rex: false });
  expect(read.panes[0]?.agent?.role).toBe("orchestrator");
});

test("the @mu_agent tag wins over the env, and no process is read for it", async () => {
  const { mux, reads } = muxWith(
    [vtmuxRow({ pane: "%1", state: "working", mu_agent: "tagged", mu_role: "worker" })],
    () => WORKER,
  );
  const read = await readLocal(store, mux, 1_000, { rex: false });
  expect(read.panes[0]?.agent).toMatchObject({ agent_name: "tagged", driver: "orchestrated" });
  expect(reads).toEqual([]);
});

test("an env without MU_MANAGED_AGENT=1 changes nothing", async () => {
  const { mux } = muxWith([vtmuxRow({ pane: "%1", state: "working" })], () => ({
    ...WORKER,
    managed: false,
  }));
  const read = await readLocal(store, mux, 1_000, { rex: false });
  expect(read.panes[0]?.agent).toMatchObject({ agent_name: null, driver: "human", role: null });
});

test("a pane's process is read once per pid: a cache hit reads nothing, a new pid reads again", async () => {
  const rows = [vtmuxRow({ pane: "%1", pid: "41", state: "working" })];
  const { mux, reads } = muxWith(rows, () => WORKER);
  await readLocal(store, mux, 1_000, { rex: false });
  const again = await readLocal(store, mux, 2_000, { rex: false });
  expect(reads).toEqual(["41"]);
  expect(again.panes[0]?.agent?.agent_name).toBe("x");

  rows.splice(0, 1, vtmuxRow({ pane: "%1", pid: "42", state: "working" }));
  await readLocal(store, mux, 3_000, { rex: false });
  expect(reads).toEqual(["41", "42"]);
});

test("a pane that leaves its server takes its cached process with it", async () => {
  const rows = [vtmuxRow({ pane: "%1", pid: "41", state: "working" })];
  const { mux } = muxWith(rows, () => WORKER);
  await readLocal(store, mux, 1_000, { rex: false });
  expect(store.paneProcesses({ kind: "default" }).size).toBe(1);
  rows.splice(0, 1);
  await readLocal(store, mux, 2_000, { rex: false });
  expect(store.paneProcesses({ kind: "default" }).size).toBe(0);
});

test("a failed process read is no fallback, no crash, and is not cached", async () => {
  const { mux, reads } = muxWith(
    [vtmuxRow({ pane: "%1", pid: "41", state: "working" })],
    () => null,
  );
  const read = await readLocal(store, mux, 1_000, { rex: false });
  expect(read.panes[0]?.agent).toMatchObject({ agent_name: null, driver: "human" });
  await readLocal(store, mux, 2_000, { rex: false });
  expect(reads).toEqual(["41", "41"]);
});

test("a plain shell pane is never read", async () => {
  const { mux, reads } = muxWith([vtmuxRow({ pane: "%1", command: "zsh" })], () => WORKER);
  const read = await readLocal(store, mux, 1_000, { rex: false });
  expect(read.panes).toEqual([]);
  expect(reads).toEqual([]);
});

test("a node-hosted idle pi pane is listed idle, as pi", async () => {
  const { mux } = muxWith([vtmuxRow({ pane: "%1", command: "node" })], () => ({
    managed: false,
    agent_name: null,
    workstream: null,
    orchestrator: false,
    harness: "pi",
  }));
  const read = await readLocal(store, mux, 1_000, { rex: false });
  expect(read.panes).toHaveLength(1);
  expect(read.panes[0]?.agent).toMatchObject({ activity: "stopped", cli: "pi", driver: "human" });
});

test("a node pane running something else stays unlisted", async () => {
  const { mux } = muxWith([vtmuxRow({ pane: "%1", command: "node" })], () => ({
    managed: false,
    agent_name: null,
    workstream: null,
    orchestrator: false,
    harness: null,
  }));
  expect((await readLocal(store, mux, 1_000, { rex: false })).panes).toEqual([]);
});

// --- reading a process --------------------------------------------------------

test("argvHarness names a harness a runtime runs, by script name or package", () => {
  expect(argvHarness(["node", "/opt/homebrew/bin/claude"])).toBe("claude");
  expect(argvHarness(["/usr/bin/node", "/usr/local/bin/pi_cli/dist/bundle/cli.js"])).toBe("pi");
  expect(argvHarness(["node", "/x/node_modules/@mariozechner/pi-coding-agent/dist/cli.js"])).toBe(
    "pi",
  );
  expect(argvHarness(["bun", "/x/node_modules/@anthropic-ai/claude-code/cli.js"])).toBe("claude");
  expect(argvHarness(["pi"])).toBe("pi");
  expect(argvHarness(["node", "/srv/app/server.js"])).toBeNull();
  // A harness-named directory under a non-runtime is not a harness.
  expect(argvHarness(["python", "/x/pi_cli/cli.py"])).toBeNull();
});

test("ps -E output keeps only mu's keys and the harness", () => {
  const facts = parsePsEnvironment(
    "node /opt/bin/pi --session s SECRET_API_KEY=hunter2 MU_MANAGED_AGENT=1 MU_AGENT_NAME=x MU_WORKSTREAM=crew MU_ORCHESTRATOR=",
  );
  expect(facts).toEqual({
    managed: true,
    agent_name: "x",
    workstream: "crew",
    orchestrator: false,
    harness: "pi",
  });
  expect(JSON.stringify(facts)).not.toContain("hunter2");
});

test("on Linux the facts come from /proc cmdline and environ", () => {
  const proc = mkdtempSync(join(tmpdir(), "murmur-proc-"));
  mkdirSync(join(proc, "41"));
  writeFileSync(join(proc, "41", "cmdline"), "node\0/usr/lib/node_modules/codex/bin/codex.js\0");
  writeFileSync(join(proc, "41", "environ"), "MU_MANAGED_AGENT=1\0MU_AGENT_NAME=x\0KEY=secret\0");
  expect(readPaneProcess("41", "linux", proc)).toEqual({
    managed: true,
    agent_name: "x",
    workstream: null,
    orchestrator: false,
    harness: "codex",
  });
  expect(readPaneProcess("99", "linux", proc)).toBeNull();
  expect(readPaneProcess("../41", "linux", proc)).toBeNull();
});

/** A `ps` on PATH that runs `body`. */
function fakePs(body: string): void {
  const bin = mkdtempSync(join(tmpdir(), "murmur-ps-"));
  writeFileSync(join(bin, "ps"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, "ps"), 0o755);
  process.env.PATH = `${bin}:${savedPath ?? ""}`;
}

test("ps answering is parsed; ps failing or hanging is null, never a throw", () => {
  fakePs('echo "node /bin/pi MU_MANAGED_AGENT=1 MU_AGENT_NAME=x"');
  expect(readPaneProcess("41", "darwin")?.agent_name).toBe("x");
  fakePs("exit 1");
  expect(readPaneProcess("41", "darwin")).toBeNull();
  fakePs("exec sleep 5");
  const started = Date.now();
  expect(readPaneProcess("41", "darwin")).toBeNull();
  expect(Date.now() - started).toBeLessThan(4_000);
});

// --- doctor -----------------------------------------------------------------------

test("doctor warns about a pane mu placed but did not tag", async () => {
  const { mux } = muxWith(
    [
      vtmuxRow({ pane: "%1", pid: "41", state: "working" }),
      vtmuxRow({ pane: "%2", pid: "42", state: "working", mu_agent: "tagged" }),
    ],
    () => WORKER,
  );
  const check = await checkMux(mux, async () => null);
  expect(check.untagged).toEqual([{ server: "default", pane: "%1", agent_name: "x" }]);
  const findings = diagnose({ host_id: "SELF", display_name: "here", peers: [], mux: check }, []);
  const warning = findings.find((finding) => finding.kind === "untagged-mu-pane");
  expect(warning?.message).toContain(
    "mu did not tag this pane; is mu older than 5.6.1? run mu agent retag",
  );
  expect(warning?.severity).toBe("observation");
});
