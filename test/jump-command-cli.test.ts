import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { createIdentity } from "../src/identity.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { openStore } from "../src/store.js";
import type { Driver, Snapshot, TmuxServer } from "../src/types.js";
import { builtArtifact } from "./helpers/built.js";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "murmur-jump-command-"));
  vi.stubEnv("MURMUR_STATE_DIR", stateDir);
  createIdentity("here");
});

function addPeer(
  name: string,
  target: string,
  panes: Array<{
    pane: string;
    agent: string;
    driver?: Driver;
    server?: TmuxServer;
    pending?: number;
  }>,
  jumpCommand = "fake-transport --command {attach}",
): void {
  const store = openStore();
  store.addPeer(name, target, jumpCommand);
  const snapshot: Snapshot = {
    murmur_snapshot: 8,
    host_id: `host-${name}`,
    display_name: name,
    murmur_version: "0.5.0",
    generated_at: 1,
    panes: panes.map(
      ({ pane, agent, driver = "human", server = { kind: "default" }, pending }) => ({
        server,
        pane: asPaneId(pane),
        session: asSessionId("$1"),
        window: asWindowId("@1"),
        session_name: "agents",
        window_name: agent,
        agent: {
          activity: "running",
          agent_name: agent,
          workstream: null,
          role: null,
          cli: "pi",
          harness: null,
          driver,
          pending: pending ?? null,
          pane_title: null,
          title: null,
          message: null,
          progress: null,
          blocked_kind: null,
          resume_command: null,
          resume_cwd: null,
          cwd: null,
          updated_at: 1,
        },
        attention: [],
      }),
    ),
  };
  store.replacePeerSnapshot(name, { ok: true, at: 1, snapshot });
  store.close();
}

function cli(...args: string[]): string {
  return execFileSync(process.execPath, [builtArtifact("cli.js"), ...args], {
    env: { ...process.env, MURMUR_STATE_DIR: stateDir },
    encoding: "utf8",
  });
}

function cliResult(...args: string[]) {
  return spawnSync(process.execPath, [builtArtifact("cli.js"), ...args], {
    env: { ...process.env, MURMUR_STATE_DIR: stateDir },
    encoding: "utf8",
  });
}

test("text output is one command that survives command substitution literally", () => {
  addPeer("dev", "developer.example", [
    { pane: "%34", agent: "mule-job", server: { kind: "label", value: "mule server" } },
  ]);
  const bin = mkdtempSync(join(tmpdir(), "murmur-fake-transport-"));
  const log = join(bin, "argv");
  writeFileSync(join(bin, "fake-transport"), `#!/bin/sh\nprintf '%s\\n' "$@" > "$LOG"\n`);
  chmodSync(join(bin, "fake-transport"), 0o755);

  const stdout = execFileSync(
    "sh",
    ["-c", 'attach="$($NODE $CLI jump-command --host dev --agent mule-job)"; eval "$attach"'],
    {
      env: {
        ...process.env,
        MURMUR_STATE_DIR: stateDir,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        NODE: process.execPath,
        CLI: builtArtifact("cli.js"),
        LOG: log,
      },
      encoding: "utf8",
    },
  );

  expect(stdout).toBe("");
  const rendered = cliResult("jump-command", "--host", "dev", "--agent", "mule-job");
  expect(rendered.status).toBe(0);
  expect(rendered.stdout).toBe(
    "fake-transport --command 'tmux -L '\\''mule server'\\'' attach -t '\\''%34'\\'''\n",
  );
  expect(rendered.stderr).toBe("");
  expect(readFileSync(log, "utf8")).toBe("--command\ntmux -L 'mule server' attach -t '%34'\n");
});

test("a Rex row is refused as a Rex pane, not with a {pane} remediation", () => {
  // Even with {attach}: a Rex block has no tmux attach for any template.
  addPeer("dev", "developer.example", [
    { pane: "block:b1", agent: "rexy", server: { kind: "rex" } },
  ]);
  const refused = cliResult("jump-command", "--host", "dev", "--agent", "rexy");
  expect(refused.status).toBe(2);
  expect(refused.stdout).toBe("");
  expect(refused.stderr).toContain("rexy on dev is a Rex pane (block:b1)");
  expect(refused.stderr).toMatch(/murmur jump j1:\S+\n$/);
  expect(refused.stderr).not.toContain("{pane}");
});

test("a {pane} template refuses a named-server row instead of printing a default-server attach", () => {
  // `{pane}` expands to a bare %N, and running the printed command lands on %N
  // of the remote DEFAULT server -- some other pane, or nothing. `murmur jump`
  // already refused this; the printer must say the same thing, not exit 0.
  addPeer(
    "dev",
    "developer.example",
    [
      { pane: "%34", agent: "mule-job", server: { kind: "label", value: "mule" } },
      { pane: "%35", agent: "plain" },
    ],
    'et dev -c "tmux attach -t {pane}"',
  );

  for (const json of [[], ["--json"]]) {
    const refused = cliResult("jump-command", "--host", "dev", "--agent", "mule-job", ...json);
    expect(refused.status).toBe(2);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toBe(
      "murmur: dev's jump command uses {pane}, which cannot identify the tmux server holding mule-job (%34)\n\n" +
        "update it:\n  murmur peer set dev --jump-command 'et dev -c {attach}'\n",
    );
  }
  // The default server is what `{pane}` can address, so that row still renders.
  expect(cli("jump-command", "--host", "dev", "--agent", "plain")).toBe(
    'et dev -c "tmux attach -t %35"\n',
  );
});

test("a generated legacy default is upgraded for a named-server row", () => {
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  addPeer(
    "dev",
    "developer.example",
    [{ pane: "%34", agent: "mule-job", server: { kind: "label", value: "mule" } }],
    `ssh -t ${quote("developer.example")} tmux attach -t ${quote(quote("{pane}"))}`,
  );
  expect(cli("jump-command", "--host", "dev", "--agent", "mule-job")).toBe(
    `ssh -t 'developer.example' env LC_CTYPE=C.UTF-8 ${quote("tmux -L 'mule' attach -t '%34'")}\n`,
  );
});

test("JSON has the stable address and rendered-command shape for hidden crew", () => {
  addPeer("dev", "developer.example", [
    {
      pane: "%8",
      agent: "worker-hidden",
      driver: "orchestrated",
      server: { kind: "path", value: "/tmp/mule.sock" },
    },
  ]);

  expect(
    JSON.parse(cli("jump-command", "--host", "dev", "--agent", "worker-hidden", "--json")),
  ).toEqual({
    host: "dev",
    agent: "worker-hidden",
    pane: "%8",
    server: { kind: "path", value: "/tmp/mule.sock" },
    command: "fake-transport --command 'tmux -S '\\''/tmp/mule.sock'\\'' attach -t '\\''%8'\\'''",
  });
});

test("host resolution prefers an exact peer name over another peer's matching target", () => {
  addPeer("dev", "shared", [{ pane: "%1", agent: "worker" }]);
  addPeer("shared", "other-target", [{ pane: "%2", agent: "worker" }]);

  expect(cli("jump-command", "--host", "shared", "--agent", "worker")).toContain("%2");
});

test("a unique exact target resolves to its peer", () => {
  addPeer("dev", "developer.example", [{ pane: "%3", agent: "worker" }]);

  expect(
    cli("jump-command", "--host", "developer.example", "--agent", "worker", "--json"),
  ).toContain('"host":"dev"');
});

test("rendering cached state never executes the configured transport", () => {
  addPeer("dev", "developer.example", [{ pane: "%9", agent: "worker" }]);
  const bin = mkdtempSync(join(tmpdir(), "murmur-no-network-"));
  const marker = join(bin, "called");
  writeFileSync(join(bin, "fake-transport"), `#!/bin/sh\ntouch "$MARKER"\n`);
  chmodSync(join(bin, "fake-transport"), 0o755);

  const result = spawnSync(
    process.execPath,
    [builtArtifact("cli.js"), "jump-command", "--host", "dev", "--agent", "worker"],
    {
      env: {
        ...process.env,
        MURMUR_STATE_DIR: stateDir,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        MARKER: marker,
      },
      encoding: "utf8",
    },
  );

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("fake-transport");
  expect(() => readFileSync(marker)).toThrow();
});

test("missing host fails with exit 2 and lists configured host-agent-pane candidates", () => {
  addPeer("dev", "developer.example", [{ pane: "%7", agent: "available" }]);

  const result = cliResult("jump-command", "--host", "missing", "--agent", "available");

  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain('host "missing" was not found');
  expect(result.stderr).toContain("dev\tavailable\t%7");
});

test("duplicate peer targets fail with exit 2 and candidate addresses", () => {
  addPeer("dev-a", "shared.example", [{ pane: "%1", agent: "alpha" }]);
  addPeer("dev-b", "shared.example", [{ pane: "%2", agent: "beta" }]);

  const result = cliResult("jump-command", "--host", "shared.example", "--agent", "alpha");

  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain('host "shared.example" is ambiguous');
  expect(result.stderr).toContain("dev-a\talpha\t%1");
  expect(result.stderr).toContain("dev-b\tbeta\t%2");
});

test("duplicate exact agent names fail with exit 2 and every matching pane", () => {
  addPeer("dev", "developer.example", [
    { pane: "%4", agent: "worker" },
    { pane: "%5", agent: "worker", driver: "orchestrated" },
  ]);

  const result = cliResult("jump-command", "--host", "dev", "--agent", "worker");

  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain('agent "worker" is ambiguous on dev');
  expect(result.stderr).toContain("dev\tworker\t%4");
  expect(result.stderr).toContain("dev\tworker\t%5");
});

test("missing exact agent fails with exit 2 and lists available candidates", () => {
  addPeer("dev", "developer.example", [{ pane: "%6", agent: "available" }]);

  const result = cliResult("jump-command", "--host", "dev", "--agent", "missing");

  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain('agent "missing" was not found on dev');
  expect(result.stderr).toContain("dev\tavailable\t%6");
});

test("status --cached never reaches a due peer", () => {
  addPeer("dev", "developer.example", [{ pane: "%1", agent: "w" }]);
  // An auth-refused peer is what made the cached read probe `ssh -O check`.
  const seeded = openStore();
  seeded.replacePeerSnapshot("dev", {
    ok: false,
    at: 2,
    error: "Permission denied (publickey).",
  });
  seeded.close();
  const bin = mkdtempSync(join(tmpdir(), "murmur-fake-ssh-"));
  const log = join(bin, "calls");
  writeFileSync(join(bin, "ssh"), `#!/bin/sh\necho "$@" >> "${log}"\nexit 255\n`);
  chmodSync(join(bin, "ssh"), 0o755);
  const result = spawnSync(
    process.execPath,
    [builtArtifact("cli.js"), "status", "--json", "--cached"],
    {
      env: { ...process.env, MURMUR_STATE_DIR: stateDir, PATH: `${bin}:${process.env.PATH ?? ""}` },
      encoding: "utf8",
    },
  );
  expect(result.status).toBe(0);
  const view = JSON.parse(result.stdout);
  expect(view.panes.map((pane: { pane: string }) => pane.pane)).toEqual(["%1"]);
  expect(() => readFileSync(log, "utf8")).toThrow();
});

test("jump verb: a bad token exits 1 with one stderr line", () => {
  const result = cliResult("jump", "nonsense");
  expect(result.status).toBe(1);
  expect(result.stderr.trim().split("\n")).toHaveLength(1);
});

test("status --json pins the stable field types at the CLI boundary", () => {
  addPeer("dev", "developer.example", [
    { pane: "%1", agent: "alpha", pending: 2 },
    { pane: "%1", agent: "beta", server: { kind: "label", value: "private" } },
  ]);
  const seeded = openStore();
  seeded.replacePeerSnapshot("dev", { ok: false, at: 5, error: "Permission denied (publickey)." });
  seeded.close();

  const view = JSON.parse(cli("status", "--json", "--cached"));
  expect(view.peers).toHaveLength(1);
  const [peer] = view.peers;
  expect(typeof peer.name).toBe("string");
  expect(typeof peer.needs_session).toBe("boolean");
  expect(peer.needs_session).toBe(true);
  expect(typeof peer.fetched_at).toBe("number");

  const byName = Object.fromEntries(
    view.panes.map((p: { agent_name: string }) => [p.agent_name, p]),
  );
  const alpha = byName.alpha;
  const beta = byName.beta;
  for (const pane of [alpha, beta]) {
    for (const key of [
      "host_id",
      "host",
      "pane",
      "window",
      "session_name",
      "window_name",
      "render_state",
      "label",
      "jump_target",
      "freshness",
      "driver",
    ]) {
      expect(typeof pane[key], key).toBe("string");
    }
    expect(pane.local).toBe(false);
    expect(typeof pane.visible).toBe("boolean");
    expect(Array.isArray(pane.attention)).toBe(true);
    expect(pane.runs_on).toBeNull();
    expect(pane.attached_pane).toBeNull();
    expect(typeof pane.updated_at).toBe("number");
  }
  expect(alpha.pending).toBe(2);
  expect(beta.pending).toBeNull();
  expect(alpha.server).toEqual({ kind: "default" });
  expect(beta.server).toEqual({ kind: "label", value: "private" });
  expect(alpha.render_state).toBe("working");
  expect(alpha.jump_target).not.toBe(beta.jump_target);
});

test("jump verb: an unreadable identity is one stderr line, no stack", () => {
  addPeer("dev", "developer.example", [{ pane: "%1", agent: "w" }]);
  const token = JSON.parse(cli("status", "--json", "--cached")).panes[0].jump_target;
  writeFileSync(join(stateDir, "identity.json"), "{");
  const result = cliResult("jump", token);
  expect(result.status).toBe(1);
  expect(result.stderr.trim().split(/\r?\n/)).toHaveLength(1);
  expect(result.stderr).not.toContain("    at ");
});

test("jump, prompt and stop --json on an uninitialised node print one JSON failure", () => {
  rmSync(join(stateDir, "identity.json"), { force: true });
  const token = `j1:${Buffer.from(JSON.stringify(["h", { kind: "default" }, "%1"])).toString("base64url")}`;
  for (const argv of [
    ["jump", token, "--json"],
    ["prompt", token, "hi", "--json"],
    ["stop", token, "--json"],
  ]) {
    const result = cliResult(...argv);
    expect(result.status, argv[0]).toBe(1);
    expect(JSON.parse(result.stdout), argv[0]).toMatchObject({
      ok: false,
      reason: "not_initialised",
    });
  }
});

test("stop with an absent rex j1 token reports not_found, not invalid_target", () => {
  const body = JSON.stringify(["host-x", { kind: "rex" }, "%9"]);
  const token = `j1:${Buffer.from(body, "utf8").toString("base64url")}`;
  const result = cliResult("stop", token, "--json");
  expect(result.stdout + result.stderr).toContain("not_found");
  expect(result.stdout + result.stderr).not.toContain("invalid_target");
});
