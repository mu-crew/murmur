import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { clearPane, clearTarget, paneServer } from "../src/cli/clear.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { jumpTarget } from "../src/jump-target.js";
import { openStore } from "../src/store.js";
import type { Location, TmuxServer } from "../src/types.js";

/**
 * `murmur clear`: dismiss the one kind of attention murmur owns.
 *
 * From 3.0 every other attention is the program's own (OSC 7501), and vtmux
 * clears `done` and `error` itself when the pane is focused, so a clear has
 * exactly one row it may touch: the `crashed` row murmur recorded for a pane
 * that vanished mid-work.
 */

beforeEach(() => {
  process.env.MURMUR_STATE_DIR = mkdtempSync(join(tmpdir(), "murmur-clear-"));
});

function at(server: TmuxServer, pane: string): Location {
  return {
    server,
    pane: asPaneId(pane),
    session: asSessionId("$0"),
    window: asWindowId("@1"),
    session_name: "work",
    window_name: null,
  };
}

function crashes(): string[] {
  const store = openStore();
  try {
    return store
      .localPanes()
      .map(
        (pane) =>
          `${pane.server.kind}:${"value" in pane.server ? pane.server.value : ""}:${pane.pane}`,
      );
  } finally {
    store.close();
  }
}

const DEFAULT: TmuxServer = { kind: "default" };
const MULE: TmuxServer = { kind: "label", value: "mule" };

test("clear dismisses the crash on that server's pane, and nothing else", () => {
  const store = openStore();
  store.recordCrash(at(DEFAULT, "%1"));
  store.recordCrash(at(MULE, "%1"));
  store.recordCrash(at(DEFAULT, "%2"));
  store.close();

  // A pane id is unique only per server: the mule %1 is a different pane.
  expect(clearPane("%1", MULE)).toBe(1);
  expect(crashes()).toEqual(["default::%1", "default::%2"]);
  // Clearing again finds nothing: idempotent, as a key binding needs.
  expect(clearPane("%1", MULE)).toBe(0);
});

test("clear is silent and total when there is nothing to clear or no store to ask", () => {
  expect(clearPane("", DEFAULT)).toBe(0);
  expect(clearPane("%404", DEFAULT)).toBe(0);
  // A store that cannot be opened is no crash to clear, not an error: a key
  // binding runs this and has nowhere to show one.
  const broken = mkdtempSync(join(tmpdir(), "murmur-clear-broken-"));
  writeFileSync(join(broken, "state.db"), "not a database");
  process.env.MURMUR_STATE_DIR = join(broken, "state.db", "nested");
  expect(clearPane("%1", DEFAULT)).toBe(0);
});

test("clear's -L, -S and --rex name a server; with none, the caller's tmux decides", () => {
  expect(paneServer({ socketName: "default" }, {})).toEqual({ kind: "default" });
  expect(paneServer({ socketName: "mule" }, {})).toEqual(MULE);
  expect(paneServer({ socketPath: "/var/run/x.sock" }, {})).toEqual({
    kind: "path",
    value: "/var/run/x.sock",
  });
  expect(paneServer({ rex: true, socketName: "mule" }, {})).toEqual({ kind: "rex" });
  // $TMUX names the server a key binding runs in.
  expect(paneServer({}, { TMUX: "/var/run/y.sock,123,0" })).toEqual({
    kind: "path",
    value: "/var/run/y.sock",
  });
  expect(paneServer({}, {})).toEqual({ kind: "default" });
});

test("a Rex block's crash is cleared by its block id", () => {
  const store = openStore();
  store.recordCrash(at({ kind: "rex" }, "block:1f2e"));
  store.close();
  expect(clearPane("block:1f2e", paneServer({ rex: true }))).toBe(1);
  expect(crashes()).toEqual([]);
});

test("clear --target dismisses the crash its jump_target names, Rex included", () => {
  const REX: TmuxServer = { kind: "rex" };
  const store = openStore();
  store.recordCrash(at(MULE, "%1"));
  store.recordCrash(at(REX, "block:01a2"));
  store.recordCrash(at(DEFAULT, "%1"));
  store.close();
  const here = { host_id: "here", display_name: "here" };
  const token = (server: TmuxServer, pane: string, host_id = "here") =>
    jumpTarget({ host_id, server, pane: asPaneId(pane) });

  expect(clearTarget(token(MULE, "%1"), here)).toBe(1);
  expect(clearTarget(token(REX, "block:01a2"), here)).toBe(1);
  expect(crashes()).toEqual(["default::%1"]);
  // Another host's %1 is not this host's %1: a peer's crash is the peer's.
  expect(clearTarget(token(DEFAULT, "%1", "peer"), here)).toBe(0);
  expect(clearTarget(token(DEFAULT, "%1"), null)).toBe(0);
  expect(clearTarget("not-a-token", here)).toBe(0);
  expect(crashes()).toEqual(["default::%1"]);
});
