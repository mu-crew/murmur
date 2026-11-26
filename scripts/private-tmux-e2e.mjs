#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderJumpCommand } from "../dist/index.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const muleRoot = process.env.MULE_REPO;
if (!muleRoot) {
  console.error("usage: MULE_REPO=/path/to/mule npm run test:private-tmux-e2e");
  process.exit(2);
}

const state = mkdtempSync(join(tmpdir(), "murmur-mule-e2e-"));
const socket = "mule";
const id = "c00e2e";
const jobRoot = join(state, "mule", "jobs", id);
const murmurState = join(state, "murmur");
// No TMUX/TMUX_PANE, and a private TMUX_TMPDIR: this run, and the murmur it
// drives, can neither see nor touch a live tmux server.
const { TMUX: _tmux, TMUX_PANE: _tmuxPane, ...inherited } = process.env;
const env = {
  ...inherited,
  MURMUR_STATE_DIR: murmurState,
  XDG_STATE_HOME: state,
  TMUX_TMPDIR: state,
};
const run = (file, args, options = {}) =>
  execFileSync(file, args, {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
const tmux = (...args) => run("tmux", ["-L", socket, "-f", "/dev/null", ...args]);

let socketPath;
let ownsServer = false;
try {
  run(process.execPath, [join(root, "dist/cli.js"), "init", "--name", "mule-e2e"]);
  run("cargo", ["test", "--manifest-path", join(muleRoot, "Cargo.toml"), "--no-run"]);
  const probe = run("cargo", [
    "run",
    "--quiet",
    "--manifest-path",
    join(muleRoot, "Cargo.toml"),
    "--bin",
    "mule",
    "--",
    "--version",
  ]);
  if (!probe.includes("0.2.0")) throw new Error(`wrong mule build: ${probe}`);

  // mule's generated wrapper is already covered by its default suite. This
  // opt-in cross-repo check runs the same final shell under a real private tmux
  // server without requiring sshd, a model provider, or the internet.
  try {
    tmux("list-sessions");
    throw new Error("local tmux -L mule is already in use; refusing to disturb it");
  } catch (error) {
    if (error instanceof Error && error.message.includes("refusing")) throw error;
  }
  tmux("new-session", "-d", "-s", "keeper", "sleep 30");
  ownsServer = true;
  // mu marks a crew pane with pane options at spawn; murmur reads them in its
  // single list-panes pass, whatever the program in the pane reports.
  const crewPane = tmux(
    "new-session",
    "-d",
    "-P",
    "-F",
    "#{pane_id}",
    "-s",
    `mule-${id}`,
    "sleep 30",
  );
  tmux("set-option", "-p", "-t", crewPane, "@mu_agent", `mule-${id}`);
  tmux("set-option", "-p", "-t", crewPane, "@mu_workstream", "e2e");
  socketPath = tmux("display-message", "-p", "#{socket_path}");

  const deadline = Date.now() + 5000;
  let snapshot;
  do {
    snapshot = JSON.parse(run(process.execPath, [join(root, "dist/cli.js"), "export"]));
    if (snapshot.panes.length === 1) break;
  } while (Date.now() < deadline);
  const pane = snapshot.panes[0];
  if (!pane) throw new Error("crew pane did not appear");
  if (pane.server.kind !== "label" || pane.server.value !== socket)
    throw new Error(`wrong server: ${JSON.stringify(pane.server)}`);
  if (pane.agent?.driver !== "orchestrated" || pane.agent.agent_name !== `mule-${id}`)
    throw new Error(`not crew: ${JSON.stringify(pane.agent)}`);

  const second = JSON.parse(run(process.execPath, [join(root, "dist/cli.js"), "export"]));
  if (!second.panes.some((candidate) => candidate.pane === pane.pane))
    throw new Error("crew pane disappeared during export");

  const attach = renderJumpCommand("et dev -c {attach}", pane);
  if (!attach.includes("tmux -L") || !attach.includes(socket) || !attach.includes("attach -t"))
    throw new Error(`bad attach: ${attach}`);

  tmux("kill-session", "-t", `=mule-${id}`);
  const gone = JSON.parse(run(process.execPath, [join(root, "dist/cli.js"), "export"]));
  if (gone.panes.length !== 0)
    throw new Error(`crew pane survived kill: ${JSON.stringify(gone.panes)}`);

  console.log(`crew=1 server=label:${socket} agent=mule-${id}`);
  console.log(`export_survived=1 pane=${pane.pane}`);
  console.log(`attach=${attach}`);
  console.log("after_kill=0");
} finally {
  if (ownsServer) {
    try {
      tmux("kill-server");
    } catch {}
  }
  if (ownsServer && socketPath) rmSync(socketPath, { force: true });
  rmSync(jobRoot, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
}
