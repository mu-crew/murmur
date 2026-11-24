import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  agentLabel,
  agentLocation,
  jumpToAgent,
  type Runner,
  remoteSessionName,
  WRAPPER_CLIENT_OPTION,
} from "../src/agents.js";
import { JUMP_CLIENT_OPTION } from "../src/goto.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { shellQuote } from "../src/jump-command.js";
import { reportJumpFailure } from "../src/jump-select.js";
import { tmux } from "../src/mux.js";
import { openStore, type Store } from "../src/store.js";
import type { PaneView } from "../src/view.js";
import { fakeMux } from "./helpers/fake-mux.js";

let store: Store;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "murmur-jump-"));
  vi.stubEnv("MURMUR_STATE_DIR", dir);
  store = openStore();
});

afterEach(() => {
  store.close();
  vi.unstubAllEnvs();
});

/**
 * One pane as every surface sees it. Remote by default, because that is the path
 * with the probe, the wrapper session and the classification rules.
 */
function view(over: Partial<PaneView> = {}): PaneView {
  return {
    host_id: "remote-host",
    host: "p",
    local: false,
    server: { kind: "default" },
    pane: asPaneId("%9"),
    session: asSessionId("$0"),
    window: asWindowId("@9"),
    session_name: null,
    window_name: null,
    activity: "running",
    attention: [],
    freshness: "fresh",
    agent_id: "agent-9",
    agent_name: null,
    pi_session: null,
    workstream: "api",
    role: null,
    cli: "pi",
    harness: null,
    driver: "human",
    model: null,
    provider: null,
    effort: null,
    provider_effort: null,
    context_pct: null,
    context_tokens: null,
    context_window: null,
    usage: null,
    pending: null,
    updated_at: 1,
    snapshot_at: null,
    fetched_at: null,
    attached_pane: null,
    runs_on: null,
    ...over,
  };
}

function localView(over: Partial<PaneView> = {}): PaneView {
  return view({ host_id: "LOCAL", host: "here", local: true, ...over });
}

/**
 * Run a remote command string the way ssh does -- joined and handed to a shell
 * -- against a stub `tmux`. Each case arm is `subcommand) body ;;`; anything
 * unlisted fails. Every invocation's subcommand is returned in `calls`, so a
 * test can see what the remote shell actually ran rather than what the command
 * string happens to spell.
 */
function runRemote(command: string, cases: string): ReturnType<Runner> & { calls: string[] } {
  const bin = mkdtempSync(join(tmpdir(), "murmur-remote-bin-"));
  const stub = join(bin, "tmux");
  const log = join(bin, "calls");
  writeFileSync(
    stub,
    `#!/bin/sh\necho "$1" >> '${log}'\ncase "$1" in\n  ${cases}\n  *) echo 'invalid option' >&2 ; exit 1 ;;\nesac\n`,
  );
  chmodSync(stub, 0o755);
  const calls = () =>
    existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  try {
    const stdout = execFileSync("sh", ["-c", command], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    return { status: 0, stdout, failed: false, calls: calls() };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    return {
      status: failure.status ?? 1,
      stdout: failure.stdout ?? "",
      failed: false,
      calls: calls(),
    };
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

/**
 * A peer whose cached snapshot names `host_id`, which is how `jumpToAgent`
 * resolves a pane's host to an ssh target. Recorded through the snapshot rather
 * than set directly, because that is the only way a host_id can enter the cache:
 * it comes out of the document the peer served.
 */
function peer(name: string, hostId: string, panes: string[] = [], jumpCommand?: string): void {
  store.addPeer(name, name, jumpCommand);
  store.replacePeerSnapshot(name, {
    ok: true,
    at: 1_000,
    snapshot: {
      murmur_snapshot: 7,
      host_id: hostId,
      display_name: name,
      murmur_version: "0.2.0",
      generated_at: 1,
      panes: panes.map((id) => ({
        server: { kind: "default" },
        pane: asPaneId(id),
        session: asSessionId("$0"),
        window: asWindowId("@9"),
        session_name: null,
        window_name: null,
        agent: null,
        attention: [
          { kind: "done" as const, message: "", source: "pi", driver: "human", requested_at: 1 },
        ],
      })),
    },
  });
}

function ok(stdout = ""): ReturnType<Runner> {
  return { status: 0, stdout, failed: false };
}

/**
 * A jump that failed must have written NOTHING: one keypress on a healthy agent
 * must not be able to remove it. Only the owning node may author facts about its
 * own panes, and a jump is a read.
 */
function snapshotOfEverything(): string {
  return JSON.stringify({
    server: { kind: "default" },
    panes: store.localPanes(),
    peers: store.peers(),
  });
}

test("agentLabel prefers a human name over any tmux id", () => {
  // The picker showed raw "$26:@79" for remote panes because names were resolved
  // against the LOCAL tmux and skipped for remote rows. Names now travel in the
  // snapshot, recorded by the node that owns the pane, so both read the same.
  const agent = view({
    window: asWindowId("@79"),
    session: asSessionId("$26"),
    session_name: "murmur",
    window_name: "nvim",
    agent_name: "reviewer-1",
    pi_session: "review the picker",
  });

  expect(agentLabel(agent)).toBe("reviewer-1");
  expect(agentLabel({ ...agent, agent_name: null })).toBe("review the picker");
  expect(agentLabel({ ...agent, agent_name: null, pi_session: null })).toBe("nvim");
  expect(agentLocation(agent)).toBe("murmur:nvim");
});

test("agentLabel falls back to the window id only when no name exists", () => {
  expect(
    agentLabel(
      view({
        window: asWindowId("@79"),
        session_name: null,
        window_name: null,
        agent_name: null,
        pi_session: null,
      }),
    ),
  ).toBe("@79");
});

test("the real tmux reports a missing per-host wrapper as absent", () => {
  // Against a real tmux, unlike the fakes below: sessionNamed does exact
  // matching over `list-sessions`, and a bare `has-session -t name` would have
  // matched by PREFIX, so a wrapper for `bub` would be found by a session called
  // `bubba`.
  expect(tmux.sessionNamed("murmur-test-no-such-session~")).toBe(false);
});

test("ssh's own failure is unreachable, and writes nothing", () => {
  peer("p", "remote-host");
  const before = snapshotOfEverything();

  const result = jumpToAgent(store, view(), fakeMux(), () => ({
    status: 255,
    stdout: "",
    failed: false,
  }));

  expect(result).toMatchObject({ ok: false, reason: "unreachable" });
  // Proves nothing about the peer's panes -- they may be alive behind a cold
  // socket -- so nothing is touched, `last_error` included.
  expect(snapshotOfEverything()).toBe(before);
});

test("a spawn that never starts is also unreachable", () => {
  peer("p", "remote-host");

  const result = jumpToAgent(store, view(), fakeMux(), () => ({
    status: null,
    stdout: "",
    failed: true,
  }));

  expect(result).toMatchObject({ ok: false, reason: "unreachable" });
});

test("a dead remote tmux is reported, and still writes nothing", () => {
  // This used to delete every replicated row for the host, which was defensible
  // under the event model -- nothing else would ever supersede them. Under
  // snapshots it is both unnecessary and wrong: the peer's next document is
  // authoritative and will simply not contain those panes, and a reader that
  // evicts rows on a probe failure is authoring about a node it does not own.
  peer("p", "remote-host");
  const before = snapshotOfEverything();

  // Not 255: ssh worked, the remote tmux did not.
  const result = jumpToAgent(store, view(), fakeMux(), () => ({
    status: 1,
    stdout: "",
    failed: false,
  }));

  expect(result).toMatchObject({ ok: false, reason: "no_tmux" });
  expect(snapshotOfEverything()).toBe(before);
});

test("a pane the peer no longer lists is pane_gone, and writes nothing", () => {
  peer("p", "remote-host");
  const before = snapshotOfEverything();

  // Peer answers, but %9 is not among its panes.
  const result = jumpToAgent(store, view(), fakeMux(), () => ok("%1\n%2\n"));

  expect(result).toMatchObject({ ok: false, reason: "pane_gone" });
  expect(snapshotOfEverything()).toBe(before);
});

test("the remote probe asks tmux for PANES, not windows", () => {
  // The probe is the remote half of the same rule the local path gets from
  // `livePanes()`, and `list-windows -a -F '#{window_id}'` cannot express it:
  // no answer to a question about windows says whether a pane exists. So the
  // command on the wire is part of the fix, not an implementation detail.
  peer("p", "remote-host");
  vi.stubEnv("TMUX", "");
  const probes: string[] = [];

  jumpToAgent(store, view(), fakeMux(), (file, args) => {
    if (file === "sh") return ok();
    probes.push(args.at(-1) ?? "");
    return ok("%9\n");
  });

  // Quoted as one string: ssh joins argv and hands it to a remote shell, which
  // would otherwise mangle the `#{...}` format and make tmux answer `-F expects
  // an argument` -- indistinguishable from an unreachable host.
  expect(probes).toEqual([`tmux list-panes -a -F '#{pane_id}'`]);
});

test("a remote agent whose pane MOVED window survives the jump", () => {
  // The regression, remote half. The peer no longer has @9 -- the pane moved --
  // but %9 is alive and jumpable. Probing windows deleted this replica and told
  // the user the agent was gone.
  peer("p", "remote-host");
  vi.stubEnv("TMUX", "");
  const attached: string[][] = [];

  const result = jumpToAgent(store, view(), fakeMux(), (file, args) => {
    if (file === "sh") {
      attached.push(args);
      return ok();
    }
    // Every pane on the peer, and no window @9 to be found anywhere.
    return ok("%9\n%3\n");
  });

  expect(result).toEqual({ ok: true });
  expect(attached).toHaveLength(1);
});

test("no configured peer for the host is no_peer", () => {
  const result = jumpToAgent(store, view(), fakeMux(), () => ok("%9\n"));

  expect(result).toMatchObject({ ok: false, reason: "no_peer" });
});

test("an existing per-host session is switched to, and no new one is opened", () => {
  peer("p", "remote-host");
  vi.stubEnv("TMUX", "/tmp/tmux-1000/default,123,0");
  let opened = 0;
  const switched: string[] = [];

  const result = jumpToAgent(
    store,
    view(),
    fakeMux({
      sessionNamed: () => true,
      sessionOption: () => "@murmur_wrapper_0a1b",
      newSession: () => {
        opened += 1;
        return true;
      },
      switchClient: (_client, session) => {
        switched.push(session);
        return true;
      },
    }),
    () => ok("%9\n"),
  );

  expect(result).toEqual({ ok: true });
  expect(opened).toBe(0);
  expect(switched).toEqual([remoteSessionName("p", "remote-host")]);
});

// Reported by review, reproduced against two real remote panes while dogfooding:
// jump to agent A on a host, come back, pick agent B on the same host, and the
// reused wrapper still shows A -- while the call reports ok: true.
test("reusing a host's wrapper retargets it at the pane that was picked", () => {
  peer("p", "remote-host");
  vi.stubEnv("TMUX", "/tmp/tmux-1000/default,123,0");
  const remoteCommands: string[] = [];

  const result = jumpToAgent(
    store,
    view({ pane: asPaneId("%42") }),
    fakeMux({ sessionNamed: () => true, sessionOption: () => "@murmur_wrapper_0a1b" }),
    (_file, args) => {
      remoteCommands.push(args.at(-1) ?? "");
      return ok("%42\n");
    },
  );

  expect(result).toEqual({ ok: true });
  // The probe is still there, AND a switch-client naming the wrapper's client
  // and the picked pane. The pane is quoted for the same reason the attach
  // command is: the local shell must not expand a `$`-leading tmux id.
  expect(remoteCommands.some((command) => /switch-client -c .* -t .*%42/.test(command))).toBe(true);
});

test("a wrapper reuse that cannot retarget fails instead of claiming success", () => {
  // Landing on the host looking at the wrong pane, with ok: true, is the
  // wrong-destination-claiming-success failure; the client must not move.
  peer("p", "remote-host");
  vi.stubEnv("TMUX", "/tmp/tmux-1000/default,123,0");
  const switched: string[] = [];

  const result = jumpToAgent(
    store,
    view({ pane: asPaneId("%42") }),
    fakeMux({
      sessionNamed: () => true,
      sessionOption: () => "@murmur_wrapper_0a1b",
      switchClient: (_client, session) => {
        switched.push(session);
        return true;
      },
    }),
    (_file, args) =>
      /switch-client/.test(args.at(-1) ?? "")
        ? { status: 1, stdout: "", failed: true }
        : ok("%42\n"),
  );

  expect(result).toMatchObject({ ok: false, reason: "attach_failed" });
  if (!result.ok) expect(result.message).not.toContain("\n");
  expect(switched).toEqual([]);
});

test("a private server's pane never reuses the default server's wrapper", () => {
  peer("p", "remote-host");
  vi.stubEnv("TMUX", "/tmp/tmux-1000/default,123,0");
  const asked: string[] = [];
  const opened: string[] = [];

  const result = jumpToAgent(
    store,
    view({ pane: asPaneId("%1"), server: { kind: "label", value: "private é" } }),
    fakeMux({
      // Only the default server's wrapper exists.
      sessionNamed: (name: string) => {
        asked.push(name);
        return name === remoteSessionName("p", "remote-host");
      },
      newSession: (name: string) => {
        opened.push(name);
        return true;
      },
    }),
    () => ok("%1\n"),
  );

  expect(result).toEqual({ ok: true });
  expect(asked[0]).not.toBe(remoteSessionName("p", "remote-host"));
  expect(opened).toEqual(asked);
});

test("with no existing session, exactly one is opened for the peer", () => {
  peer("p", "remote-host");
  vi.stubEnv("TMUX", "/tmp/tmux-1000/default,123,0");
  const opened: string[] = [];

  const result = jumpToAgent(
    store,
    view(),
    fakeMux({
      newSession: (name, command) => {
        opened.push(`${name} :: ${command}`);
        return true;
      },
    }),
    () => ok("%9\n"),
  );

  expect(result).toEqual({ ok: true });
  expect(opened).toHaveLength(1);
  // Named after the configured peer, and the remote PANE is quoted against the
  // local shell. `%9` is shell-inert where `$0:@9` was not, so the quoting is no
  // longer what rescues this particular value -- it stays because nothing
  // validates a pane id's shape (`asPaneId` deliberately round-trips whatever a
  // peer sent), and the layer below still crosses two shells.
  expect(opened[0]).toContain(`${remoteSessionName("p", "remote-host")} ::`);
  expect(opened[0]).toContain("'%9'");
});

test("private-server preflight and attach use the snapshot's server selector", () => {
  peer("p", "remote-host");
  vi.stubEnv("TMUX", "");
  const calls: [string, string[]][] = [];

  const result = jumpToAgent(
    store,
    view({ server: { kind: "label", value: "co'op; echo BAD" } }),
    fakeMux(),
    (file, args) => {
      calls.push([file, args]);
      return calls.length === 1 ? ok("%9\n") : ok();
    },
  );

  expect(result).toEqual({ ok: true });
  expect(calls[0]?.[1].at(-1)).toBe("tmux -L 'co'\\''op; echo BAD' list-panes -a -F '#{pane_id}'");
  expect(calls[1]).toEqual([
    "sh",
    [
      "-c",
      "ssh -t 'p' env LC_CTYPE=C.UTF-8 'tmux -L '\\''co'\\''\\'\\'''\\''op; echo BAD'\\'' attach -t '\\''%9'\\'''",
    ],
  ]);
});

test("a custom {pane} template refuses a private server before opening a connection", () => {
  peer("dev", "remote-host", [], "et dev -c 'tmux attach -t {pane}'");
  const calls: string[] = [];

  const result = jumpToAgent(
    store,
    view({ server: { kind: "path", value: "/tmp/private.sock" }, agent_name: "mule-af31c5" }),
    fakeMux(),
    (file) => {
      calls.push(file);
      return ok();
    },
  );

  // This runner is the network boundary. An empty call list proves the refusal
  // happens before either the preflight ssh or the configured transport.
  expect(calls).toEqual([]);
  expect(result).toEqual({
    ok: false,
    reason: "unsupported_server",
    message:
      "murmur: dev's jump command uses {pane}, which cannot identify the tmux server holding mule-af31c5 (%9)\n\n" +
      "update it:\n" +
      "  murmur peer set dev --jump-command 'et dev -c {attach}'",
  });
});

test("the wrapper runs the peer's configured jump command after the ssh probe", () => {
  peer("p", "remote-host", [], 'et dev -c "tmux attach -t {pane}"');
  vi.stubEnv("TMUX", "/tmp/tmux-1000/default,123,0");
  const calls: string[][] = [];
  let command = "";

  const result = jumpToAgent(
    store,
    view(),
    fakeMux({
      newSession: (_name, value) => {
        command = value;
        return true;
      },
    }),
    (file, args) => {
      calls.push([file, ...args]);
      return ok("%9\n");
    },
  );

  expect(result).toEqual({ ok: true });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.[0]).toBe("ssh");
  expect(command).toBe('et dev -c "tmux attach -t %9"');
});

test("the wrapper session hides the local status bar and disables the local prefix", () => {
  // The whole point of a session rather than a window. Without `prefix None`
  // the local tmux eats ^b and you need ^b b to reach the remote; without
  // `status off` two status bars stack and the jump does not read as full
  // screen. Both options are per-session, which is what makes this safe -- as a
  // window they would have been global and broken every local session.
  peer("p", "remote-host");
  vi.stubEnv("TMUX", "/tmp/tmux-1000/default,123,0");
  const options: string[] = [];

  jumpToAgent(
    store,
    view(),
    fakeMux({
      setSessionOption: (session, option, value) => options.push(`${session} ${option}=${value}`),
    }),
    () => ok("%9\n"),
  );

  const wrapper = remoteSessionName("p", "remote-host");
  expect(options).toEqual([
    // Which remote option its client recorded itself in, for reuse to find it.
    expect.stringMatching(
      new RegExp(`^${wrapper} ${WRAPPER_CLIENT_OPTION}=@murmur_wrapper_[0-9a-f]{12}$`),
    ),
    `${wrapper} status=off`,
    `${wrapper} prefix=None`,
    `${wrapper} detach-on-destroy=previous`,
  ]);
});

test("the wrapper returns the originating client to where the jump started", () => {
  // The return is part of the wrapper's own command, so leaving the remote --
  // by any means -- lands you back where you were. It must name the client
  // explicitly: a picker runs in a popup, which is a client of its own
  // that dies with the picker, so a bare switch-client would move the wrong
  // one. The origin must also be read BEFORE the wrapper exists, or it would
  // record the wrapper as home and the return would be a no-op.
  peer("p", "remote-host");
  vi.stubEnv("TMUX", "/tmp/tmux-1000/default,123,0");
  let command = "";

  jumpToAgent(
    store,
    view(),
    fakeMux({
      clientName: () => "/dev/ttys004",
      currentTarget: () => "work:@3",
      newSession: (_name, cmd) => {
        command = cmd;
        return true;
      },
    }),
    () => ok("%9\n"),
  );

  // Ordered: attach first, return only once it exits.
  //
  // The remote target is quoted TWICE, and both layers are load-bearing. This
  // string is a wrapper command, so a local shell strips the outer layer to
  // `'%9'`, ssh joins its arguments and a remote shell strips the inner one to
  // `%9`. The lesson was learned on a session id: with one layer the local shell
  // expanded `$0` and the remote attach failed with "can't find session",
  // verified by hand through `sh -c`. The target is a pane now, which happens to
  // be shell-inert, so this asserts the STRUCTURE that protects the next value
  // rather than a rescue this one needs.
  const mark = (option: string) =>
    ` ';' set-option -gF ${option} '#{client_name} #{client_created}'`;
  const attach = `tmux attach -t '%9'${mark(JUMP_CLIENT_OPTION)}${mark("@murmur_wrapper_X")}`;
  expect(command.replace(/@murmur_wrapper_[0-9a-f]{12}/, "@murmur_wrapper_X")).toBe(
    `ssh -t 'p' env LC_CTYPE=C.UTF-8 ${shellQuote(attach)}; ` +
      `tmux switch-client -c '/dev/ttys004' -t '=work:@3'`,
  );
});

test("a wrapper name never starts with a tmux id sigil", () => {
  // The trap this design walked into: the old per-host WINDOW was named
  // `@<host>`, which is harmless for a window name but fatal for a session
  // name. `-t @bubba` parses as a window id, so every set-option and
  // switch-client against it failed with `can't find window` -- verified
  // against a real tmux while designing this.
  // Two peers whose sanitised labels collide get different wrapper sessions,
  // because the wrapper's identity is the HOST it reaches and not the label a
  // human typed. Without the host id, `a:b` and `a.b` both become `a-b~`, and a
  // jump to the second finds the first's wrapper and attaches to the wrong
  // machine while reporting success -- the same failure the pane retarget
  // fixed one level down, at the level of the host.
  expect(remoteSessionName("a:b", "host-A")).not.toBe(remoteSessionName("a.b", "host-B"));
  expect(remoteSessionName("@foo", "host-A")).not.toBe(remoteSessionName("foo", "host-B"));
  // Stable for one peer, or reuse would never match and every jump would stack
  // a new window.
  expect(remoteSessionName("dev", "host-A")).toBe(remoteSessionName("dev", "host-A"));
  expect(remoteSessionName("bubba")).toBe("bubba~");
  expect(remoteSessionName("@bubba")).toBe("bubba~");
  expect(remoteSessionName("$0")).toBe("0~");
  expect(remoteSessionName("%1")).toBe("1~");
});

test("a failed new-session is reported, not swallowed as success", () => {
  peer("p", "remote-host");
  vi.stubEnv("TMUX", "/tmp/tmux-1000/default,123,0");

  const result = jumpToAgent(store, view(), fakeMux({ newSession: () => false }), () => ok("%9\n"));

  expect(result).toMatchObject({ ok: false, reason: "attach_failed" });
});

test("a wrapper that opens but cannot be switched to is reported", () => {
  // Distinct from the above: the ssh IS running, so the message must not claim
  // nothing happened. Silently returning ok here would leave an invisible
  // session holding a live remote attach.
  peer("p", "remote-host");
  vi.stubEnv("TMUX", "/tmp/tmux-1000/default,123,0");

  const result = jumpToAgent(store, view(), fakeMux({ switchClient: () => false }), () =>
    ok("%9\n"),
  );

  expect(result).toMatchObject({ ok: false, reason: "attach_failed" });
  if (!result.ok) expect(result.message).toContain(remoteSessionName("p", "remote-host"));
});

test("outside tmux, no local wrapper session is created", () => {
  // The case the wrapper must not touch. There is no local client to switch,
  // nothing to return to but the invoking shell, and no local status bar or
  // prefix to suppress -- a direct ssh is already full-screen and prefix-clean.
  // Creating a session here would attach a client to a server the user never
  // asked for, and leave them inside tmux on exit rather than at their prompt.
  peer("p", "remote-host");
  vi.stubEnv("TMUX", "");
  let sessions = 0;
  const attached: string[][] = [];

  const result = jumpToAgent(
    store,
    view(),
    fakeMux({
      newSession: () => {
        sessions += 1;
        return true;
      },
    }),
    (file, args) => {
      if (file === "sh") {
        attached.push(args);
        return ok();
      }
      return ok("%9\n");
    },
  );

  expect(result).toEqual({ ok: true });
  expect(sessions).toBe(0);
  // The configured command is opaque, so the shell parses it just as it does
  // inside a wrapper session.
  expect(attached).toEqual([
    ["-c", "ssh -t 'p' env LC_CTYPE=C.UTF-8 'tmux attach -t '\\''%9'\\'''"],
  ]);
});

test("outside tmux, the configured jump command runs through a shell", () => {
  peer("p", "remote-host", [], 'et dev -c "tmux attach -t {pane}"');
  vi.stubEnv("TMUX", "");
  const calls: [string, string[], boolean | undefined][] = [];

  const result = jumpToAgent(store, view(), fakeMux(), (file, args, inherit) => {
    calls.push([file, args, inherit]);
    return calls.length === 1 ? ok("%9\n") : ok();
  });

  expect(result).toEqual({ ok: true });
  expect(calls[0]?.[0]).toBe("ssh");
  expect(calls[1]).toEqual(["sh", ["-c", 'et dev -c "tmux attach -t %9"'], true]);
});

test("outside tmux, a failed ssh attach is reported", () => {
  peer("p", "remote-host");
  vi.stubEnv("TMUX", "");

  const result = jumpToAgent(store, view(), fakeMux(), (file) =>
    // The probe succeeds; the attach that follows does not.
    file === "sh" ? { status: 1, stdout: "", failed: false } : ok("%9\n"),
  );

  expect(result).toMatchObject({ ok: false, reason: "attach_failed" });
});

test("a local jump reports a failed select-window instead of claiming success", () => {
  vi.stubEnv("TMUX", "/tmp/tmux-501/default,1,0");
  // A select-window that fails is the local twin of the remote symptom: the
  // picker closes, nothing moves, and nothing says why.
  const result = jumpToAgent(
    store,
    localView(),
    fakeMux({ livePanes: () => new Set([asPaneId("%9")]), attach: () => false }),
  );

  expect(result).toMatchObject({ ok: false, reason: "attach_failed" });
});

test("a local jump to a live pane succeeds", () => {
  vi.stubEnv("TMUX", "/tmp/tmux-501/default,1,0");
  const servers: unknown[] = [];
  const result = jumpToAgent(
    store,
    localView({ server: { kind: "label", value: "mule" } }),
    fakeMux({
      livePanes: (server) => {
        servers.push(server);
        return new Set([asPaneId("%9")]);
      },
      attach: (_pane, server) => {
        servers.push(server);
        return true;
      },
    }),
  );

  expect(result).toEqual({ ok: true });
  expect(servers).toEqual([
    { kind: "label", value: "mule" },
    { kind: "label", value: "mule" },
  ]);
});

test("a local pane that MOVED window is still jumped to, and nothing is written", () => {
  vi.stubEnv("TMUX", "/tmp/tmux-501/default,1,0");
  // The regression this rule exists for, and the reproduction that filed it:
  // `move-pane -s %0 -t @1` leaves %0 alive in its new window and removes @0
  // from list-windows entirely. Judging the pane by its recorded WINDOW
  // therefore condemned a healthy pane on one keypress, and the delete was
  // permanent for a local pane.
  store.claimAgent({
    location: {
      server: { kind: "default" },
      session: asSessionId("$0"),
      window: asWindowId("@9"),
      pane: asPaneId("%9"),
      session_name: null,
      window_name: null,
    },
    owner_pid: process.pid,
    meta: {
      agent_name: null,
      pi_session: null,
      workstream: "api",
      role: null,
      cli: "pi",
      driver: "human",
    },
  });
  const before = snapshotOfEverything();
  const attempted: string[] = [];

  const result = jumpToAgent(
    store,
    localView(),
    fakeMux({
      // The pane's recorded window is gone; the pane itself is not. Panes are
      // the only liveness question tmux is asked, which is the structural half
      // of this fix.
      livePanes: () => new Set([asPaneId("%9")]),
      attach: (pane) => {
        attempted.push(pane);
        return true;
      },
    }),
  );

  // Attempted, not skipped: the jump is the whole point of not deleting.
  expect(result).toEqual({ ok: true });
  // The PANE, not `$0:@9`. The recorded window is exactly what went stale when
  // the pane moved, so attaching by it condemned the healthy agent this test
  // exists to protect -- the liveness check passed and the attach then failed.
  expect(attempted).toEqual(["%9"]);
  expect(snapshotOfEverything()).toBe(before);
});

test("a local pane that is really gone is pane_gone, and still writes nothing", () => {
  vi.stubEnv("TMUX", "/tmp/tmux-501/default,1,0");
  // Reported, not cleared. Reconciliation removes the row -- it is the one path
  // that consults tmux and the pid table together, inside one transaction -- and
  // a jump has no business doing half of that job from a keypress.
  store.requestAttention({
    kind: "done",
    location: {
      server: { kind: "default" },
      session: asSessionId("$0"),
      window: asWindowId("@9"),
      pane: asPaneId("%9"),
      session_name: null,
      window_name: null,
    },
    message: "",
    source: "pi",
    driver: "human",
  });
  const before = snapshotOfEverything();

  const result = jumpToAgent(
    store,
    localView(),
    // tmux answered, and %9 is not among the panes.
    fakeMux({ livePanes: () => new Set([asPaneId("%1")]) }),
  );

  expect(result).toMatchObject({ ok: false, reason: "pane_gone" });
  if (!result.ok) expect(result.message).toContain("its pane no longer exists");
  expect(snapshotOfEverything()).toBe(before);
});

test("a local jump proceeds when tmux cannot answer at all", () => {
  vi.stubEnv("TMUX", "/tmp/tmux-501/default,1,0");
  // null is "could not tell", not "no panes". Conflating them deleted every
  // agent on the host the moment tmux was briefly unreachable.
  const result = jumpToAgent(store, localView(), fakeMux({ livePanes: () => null }));

  expect(result).toEqual({ ok: true });
});

test("agentLabel shortens a session path to the segment that identifies it", () => {
  // Session names are conventionally paths, because `tms` and friends name a
  // session after the directory it was opened in. The last segment is the part
  // that says which work it is.
  expect(agentLabel(view({ session_name: "hacking/murmur" }))).toBe("murmur");
  expect(agentLabel(view({ session_name: "a/b/c/deep" }))).toBe("deep");
  // Already a leaf, so unchanged.
  expect(agentLabel(view({ session_name: "dotfiles" }))).toBe("dotfiles");
});

test("agentLabel keeps a degenerate session name rather than emptying the column", () => {
  // A name that is all separators has no last segment. Returning "" would blank
  // the picker's name column, which is worse than printing something odd.
  expect(agentLabel(view({ session_name: "/" }))).toBe("/");
  expect(agentLabel(view({ session_name: "trailing/" }))).toBe("trailing");
});

test("agentLabel prefers every more specific name over the session", () => {
  // The precedence itself, asserted here rather than only through the picker:
  // mu's name, then pi's session, then a window name a human chose.
  const session = { session_name: "hacking/murmur" };
  expect(agentLabel(view({ ...session, window_name: "nvim" }))).toBe("nvim");
  expect(agentLabel(view({ ...session, window_name: "nvim", pi_session: "Fix pick" }))).toBe(
    "Fix pick",
  );
  expect(
    agentLabel(
      view({ ...session, window_name: "nvim", pi_session: "Fix pick", agent_name: "w-1" }),
    ),
  ).toBe("w-1");
});

test("the wrapper's own attach marks its client, and the probe arms nothing", () => {
  // This is what makes `PREFIX G` on the remote machine mean "leave" rather
  // than "show me that machine's dash". The mark rides on the attach command
  // the wrapper runs, so only a client that attached is marked. The probe used
  // to arm a one-shot client-attached hook, and when the wrapper then failed
  // to start, the hook marked the next unrelated login.
  peer("p", "remote-host");
  vi.stubEnv("TMUX", "/tmp/tmux-1000/default,123,0");
  const remoteCommands: string[] = [];
  let wrapper = "";

  const result = jumpToAgent(
    store,
    view(),
    fakeMux({
      newSession: (_name, command) => {
        wrapper = command;
        return true;
      },
    }),
    (_file, args) => {
      remoteCommands.push(args.at(-1) ?? "");
      return ok("%9\n");
    },
  );

  expect(result).toEqual({ ok: true });
  expect(remoteCommands).toHaveLength(1);
  expect(remoteCommands[0]).not.toMatch(/set-hook|set-option/);
  expect(wrapper).toContain(`set-option -gF ${JUMP_CLIENT_OPTION}`);
});

test("a remote tmux that fails the pane list is no_tmux", () => {
  peer("p", "remote-host");
  vi.stubEnv("TMUX", "/tmp/tmux-1000/default,123,0");

  const result = jumpToAgent(store, view(), fakeMux(), (file, args) =>
    file === "ssh" ? runRemote(args.at(-1) ?? "", "list-panes) exit 1 ;;") : ok(),
  );

  expect(result).toMatchObject({ ok: false, reason: "no_tmux" });
});

test("a pane the remote tmux no longer has is pane_gone", () => {
  peer("p", "remote-host");
  vi.stubEnv("TMUX", "/tmp/tmux-1000/default,123,0");

  const result = jumpToAgent(store, view(), fakeMux(), (file, args) =>
    file === "ssh" ? runRemote(args.at(-1) ?? "", "list-panes) echo '%1' ;;") : ok(),
  );

  expect(result).toMatchObject({ ok: false, reason: "pane_gone" });
});

/**
 * A private "remote" tmux server plus a second server whose panes act as
 * terminals, since a tmux client needs a tty. Both under a short TMUX_TMPDIR
 * (macOS's per-user $TMPDIR hits the unix socket length limit). The runner
 * runs each "ssh" command through a real local sh, as the remote side would.
 */
function realRemote() {
  const root = mkdtempSync("/tmp/murmur-jump-");
  const label = `murmur-jump-${process.pid}`;
  const env = { ...process.env, TMUX_TMPDIR: root, TMUX: "" };
  const on =
    (server: string) =>
    (...args: string[]) =>
      execFileSync("tmux", ["-L", server, "-f", "/dev/null", ...args], {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
        env,
      }).trim();
  const remote = on(label);
  const terminals = on(`${label}-terminals`);
  const run: Runner = (_file, args) => {
    try {
      const stdout = execFileSync("sh", ["-c", args.at(-1) ?? ""], {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "ignore"],
        env,
      });
      return { status: 0, stdout, failed: false };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string };
      return { status: failure.status ?? 1, stdout: failure.stdout ?? "", failed: false };
    }
  };
  /** Start `command` on a fresh terminal and wait until one more client is attached. */
  const attachClient = (command: string) => {
    const before = remote("list-clients", "-F", "#{client_name}").split("\n").filter(Boolean);
    terminals("new-session", "-d", `TMUX= ${command}`);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const now = remote("list-clients", "-F", "#{client_name}").split("\n").filter(Boolean);
      const added = now.find((client) => !before.includes(client));
      if (added) return added;
      execFileSync("sleep", ["0.1"]);
    }
    throw new Error(`no client attached for ${command}`);
  };
  const cleanup = () => {
    for (const tmux of [terminals, remote]) {
      try {
        tmux("kill-server");
      } catch {
        // Never started.
      }
    }
    rmSync(root, { recursive: true, force: true });
  };
  /** The remote marker once it settles: a client's commands run after it is listed. */
  const marker = () => {
    const read = () => remote("show-options", "-gqv", JUMP_CLIENT_OPTION);
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline && read() === "") execFileSync("sleep", ["0.1"]);
    return read();
  };
  const ordinaryAttach = (session: string) => `tmux -L ${label} -f /dev/null attach -t ${session}`;
  return { label, remote, run, attachClient, ordinaryAttach, marker, cleanup };
}

test("against a real tmux a failed wrapper marks nobody, and a started one marks its client", () => {
  const rig = realRemote();
  try {
    rig.remote("new-session", "-d", "-s", "agents", "sleep 300");
    const pane = asPaneId(rig.remote("list-panes", "-a", "-F", "#{pane_id}"));
    peer("p", "remote-host", [], "sh -c {attach}");
    vi.stubEnv("TMUX", "/tmp/tmux-1000/default,123,0");
    const server = { kind: "label" as const, value: rig.label };

    // The local wrapper fails to open, so nothing attaches; the next ordinary
    // login must not be taken for a jump client.
    const failed = jumpToAgent(
      store,
      view({ server, pane }),
      fakeMux({ newSession: () => false }),
      rig.run,
    );
    expect(failed).toMatchObject({ ok: false, reason: "attach_failed" });
    rig.attachClient(rig.ordinaryAttach("agents"));
    expect(rig.marker()).toBe("");

    // A wrapper that starts: its own command, run on a terminal, marks exactly
    // the client it attached.
    let wrapper = "";
    const started = jumpToAgent(
      store,
      view({ server, pane }),
      fakeMux({
        newSession: (_name, command) => {
          wrapper = command;
          return true;
        },
      }),
      rig.run,
    );
    expect(started).toEqual({ ok: true });
    const client = rig.attachClient(wrapper);
    const created = rig.remote("display-message", "-p", "-c", client, "#{client_created}");
    expect(rig.marker()).toBe(`${client} ${created}`);
  } finally {
    rig.cleanup();
  }
});

test("against a real tmux reuse moves the wrapper's own client, not another on that host", () => {
  // A bare `switch-client -t %N` lets tmux choose the client. With an operator
  // attached to the same host it moved theirs, reported success, and left the
  // wrapper where it was.
  const rig = realRemote();
  try {
    for (const session of ["agents", "human", "chosen"]) {
      rig.remote("new-session", "-d", "-s", session, "sleep 300");
    }
    const paneOf = (session: string) =>
      asPaneId(rig.remote("list-panes", "-t", `=${session}:`, "-F", "#{pane_id}"));
    peer("p", "remote-host", [], "sh -c {attach}");
    vi.stubEnv("TMUX", "/tmp/tmux-1000/default,123,0");
    const server = { kind: "label" as const, value: rig.label };
    // A local wrapper session in memory: its command runs on a terminal of the
    // rig, its options are kept for the reuse to read.
    const options = new Map<string, string>();
    let wrapper = "";
    const mux = fakeMux({
      sessionNamed: () => wrapper !== "",
      newSession: (_name, command) => {
        wrapper = command;
        return true;
      },
      setSessionOption: (_session, option, value) => {
        options.set(option, value);
      },
      sessionOption: (_session, option) => options.get(option) ?? null,
    });

    expect(jumpToAgent(store, view({ server, pane: paneOf("agents") }), mux, rig.run)).toEqual({
      ok: true,
    });
    const own = rig.attachClient(wrapper);
    // Attached last, so it is the client a bare switch-client picks.
    const human = rig.attachClient(rig.ordinaryAttach("human"));

    expect(jumpToAgent(store, view({ server, pane: paneOf("chosen") }), mux, rig.run)).toEqual({
      ok: true,
    });
    const sessions = new Map(
      rig
        .remote("list-clients", "-F", "#{client_name} #{session_name}")
        .split("\n")
        .map((line) => line.split(" ") as [string, string]),
    );
    expect(sessions.get(own)).toBe("chosen");
    expect(sessions.get(human)).toBe("human");
  } finally {
    rig.cleanup();
  }
});

test("a wrapper whose remote client cannot be identified is replaced, not retargeted blind", () => {
  // No recorded client (a wrapper from an older murmur), or one that is no
  // longer attached: any switch-client would be tmux's pick of client.
  peer("p", "remote-host");
  vi.stubEnv("TMUX", "/tmp/tmux-1000/default,123,0");
  const name = remoteSessionName("p", "remote-host");
  for (const recorded of [null, "@murmur_wrapper_0a1b"]) {
    const killed: string[] = [];
    const opened: string[] = [];
    const result = jumpToAgent(
      store,
      view(),
      fakeMux({
        sessionNamed: () => true,
        sessionOption: () => recorded,
        killSession: (session) => {
          killed.push(session);
          return true;
        },
        newSession: (session) => {
          opened.push(session);
          return true;
        },
      }),
      (_file, args) =>
        // The recorded client is gone: the remote check exits 1.
        /switch-client/.test(args.at(-1) ?? "")
          ? { status: 1, stdout: "", failed: false }
          : ok("%9\n"),
    );
    expect(result, String(recorded)).toEqual({ ok: true });
    expect(killed).toEqual([name]);
    expect(opened).toEqual([name]);
  }
});

test("reusing a wrapper retargets its existing remote client without marking another", () => {
  peer("p", "remote-host");
  vi.stubEnv("TMUX", "/tmp/tmux-1000/default,123,0");
  const remoteCommands: string[] = [];

  const result = jumpToAgent(
    store,
    view({ pane: asPaneId("%42") }),
    fakeMux({ sessionNamed: () => true, sessionOption: () => "@murmur_wrapper_0a1b" }),
    (_file, args) => {
      remoteCommands.push(args.at(-1) ?? "");
      return ok("%42\n");
    },
  );

  expect(result).toEqual({ ok: true });
  expect(remoteCommands).toHaveLength(2);
  expect(remoteCommands[1]).toContain("switch-client");
  expect(remoteCommands.every((command) => !command.includes(JUMP_CLIENT_OPTION))).toBe(true);
});

test("outside tmux the jump marks no client, because there is nothing to come back to", () => {
  // No local wrapper, no local client, and nothing to restore but the invoking
  // shell -- so a detach here would drop the operator out of their own session
  // for no gain.
  peer("p", "remote-host");
  vi.stubEnv("TMUX", "");
  const commands: string[] = [];

  jumpToAgent(store, view(), fakeMux(), (file, args) => {
    commands.push(args.at(-1) ?? "");
    return file === "sh" ? ok() : ok("%9\n");
  });

  expect(commands.length).toBeGreaterThan(1);
  expect(commands.every((command) => !command.includes(JUMP_CLIENT_OPTION))).toBe(true);
});

test("outside tmux a local jump attaches here, and never switches some other client", () => {
  // A bare `switch-client` with no $TMUX moved another terminal's tmux
  // client and reported success.
  let switched = 0;
  const calls: [string, string[], boolean | undefined][] = [];
  const result = jumpToAgent(
    store,
    localView({ server: { kind: "label", value: "mule" } }),
    fakeMux({
      livePanes: () => new Set([asPaneId("%9")]),
      attach: () => {
        switched += 1;
        return true;
      },
    }),
    (file, args, inherit) => {
      calls.push([file, args, inherit]);
      return ok();
    },
    {},
  );
  expect(result).toEqual({ ok: true });
  expect(switched).toBe(0);
  expect(calls).toEqual([["sh", ["-c", "tmux -L 'mule' attach -t '%9'"], true]]);
});

test("in a Rex pane a local jump opens the agent in a new tab of this session", () => {
  const calls: [string, string[], boolean | undefined][] = [];
  const result = jumpToAgent(
    store,
    localView({ agent_name: "worker-1" }),
    fakeMux({ livePanes: () => new Set([asPaneId("%9")]) }),
    (file, args, inherit) => {
      calls.push([file, args, inherit]);
      return ok();
    },
    { TERM_PROGRAM: "rex", REX_SESSION: "session:abc" },
  );
  expect(result).toEqual({ ok: true });
  expect(calls).toEqual([
    [
      "rex",
      ["window", "new", "-s", "session:abc", "worker-1", "--", "sh", "-c", "tmux attach -t '%9'"],
      undefined,
    ],
  ]);
});

test("in a Rex pane a remote jump probes, then opens the jump command in a new tab", () => {
  peer("p", "remote-host");
  const calls: [string, string[], boolean | undefined][] = [];
  const result = jumpToAgent(
    store,
    view({ agent_name: "worker-9" }),
    fakeMux(),
    (file, args, inherit) => {
      calls.push([file, args, inherit]);
      return calls.length === 1 ? ok("%9\n") : ok();
    },
    { TERM_PROGRAM: "rex", REX_SESSION: "session:abc" },
  );
  expect(result).toEqual({ ok: true });
  expect(calls[0]?.[0]).toBe("ssh");
  // No arm: nothing local to come back to.
  expect(calls[0]?.[1].at(-1)).not.toMatch(/set-hook/);
  expect(calls[1]).toEqual([
    "rex",
    [
      "window",
      "new",
      "-s",
      "session:abc",
      "p · worker-9",
      "--",
      "sh",
      "-c",
      "ssh -t 'p' env LC_CTYPE=C.UTF-8 'tmux attach -t '\\''%9'\\'''",
    ],
    undefined,
  ]);
});

test("in a Rex pane a tab that cannot be opened is reported", () => {
  const result = jumpToAgent(
    store,
    localView(),
    fakeMux({ livePanes: () => new Set([asPaneId("%9")]) }),
    () => ({ status: 1, stdout: "", failed: false }),
    { TERM_PROGRAM: "rex", REX_SESSION: "session:abc" },
  );
  expect(result).toMatchObject({ ok: false, reason: "attach_failed" });
});

test("outside tmux a local pane that is gone is pane_gone, and nothing is run", () => {
  let ran = 0;
  const result = jumpToAgent(
    store,
    localView(),
    fakeMux({ livePanes: () => new Set([asPaneId("%1")]) }),
    () => {
      ran += 1;
      return ok();
    },
    {},
  );
  expect(result).toMatchObject({ ok: false, reason: "pane_gone" });
  expect(ran).toBe(0);
});

test("the peer-set remediation survives a backslash line continuation", () => {
  const legacy = "ssh -t \\\n  legacy.invalid 'tmux attach -t {pane}'";
  peer("p", "remote-host", [], legacy);
  const result = jumpToAgent(
    store,
    view({ server: { kind: "label", value: "private" } }),
    fakeMux(),
    () => ok("%9\n"),
  );
  expect(result).toMatchObject({ ok: false, reason: "unsupported_server" });
  if (result.ok) return;
  // What the user sees: the message as the one-line reporter prints it.
  let line = "";
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    line += String(chunk);
    return true;
  });
  reportJumpFailure(result.message);
  spy.mockRestore();
  process.exitCode = 0;
  expect(line.trim().split("\n")).toHaveLength(1);
  const printed = line.split("update it:").at(1)?.trim() ?? "";
  expect(printed).toContain("murmur peer set");
  // Run what the user would paste: murmur prints its argument, then the
  // suggested template is run with {attach} filled and an ssh shim logs argv.
  const script = `murmur() { shift 4; printf '%s' "$1"; }; ${printed}`;
  const template = execFileSync("sh", ["-c", script], { encoding: "utf8" });
  const argv = execFileSync(
    "sh",
    [
      "-c",
      `ssh() { printf '%s\\n' "$@"; }; ${template.replace("{attach}", "'tmux -L private attach -t %1'")}`,
    ],
    { encoding: "utf8" },
  )
    .split("\n")
    .slice(0, -1);
  expect(argv).toEqual(["-t", "legacy.invalid", "tmux -L private attach -t %1"]);
});
