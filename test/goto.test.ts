import { expect, test } from "vitest";
import {
  DASH_SESSION,
  type GotoWorld,
  gotoDecision,
  parseReturnMarker,
  returnOption,
  runGoto,
} from "../src/goto.js";
import { asPaneId, asWindowId } from "../src/ids.js";
import { fakeMux } from "./helpers/fake-mux.js";

const DASH = asPaneId("%7");
const DASH_WINDOW = asWindowId("@7");
const WORK = { pane: asPaneId("%2"), window: asWindowId("@2") };
const OPTIONS = { initialised: true, dashCommand: ["node", "murmur", "dash"] };

/** Every world this decision reads, with the ordinary local case as the base. */
function world(over: Partial<GotoWorld> = {}): GotoWorld {
  return {
    insideTmux: true,
    client: "/dev/ttys001 100",
    jumpClient: null,
    dashPane: DASH,
    livePanes: new Set([DASH, WORK.pane]),
    liveWindows: new Set([DASH_WINDOW, WORK.window]),
    here: WORK,
    returnTo: null,
    initialised: true,
    ...over,
  };
}

const IN_DASH = { pane: DASH, window: DASH_WINDOW };

test("an ordinary client switches to the marked dash pane", () => {
  expect(gotoDecision(world())).toEqual({ kind: "switch", pane: DASH });
});

test("the client murmur attached for a remote jump detaches instead of switching", () => {
  // The remote server is the one being asked, so "switch to the dash" would
  // move this client to a dash on the REMOTE machine. Detaching hands the
  // originating local client back to the wrapper's restore command, which is
  // what returns the operator to the dash they came from.
  const decision = gotoDecision(
    world({ jumpClient: "/dev/ttys001 100", dashPane: asPaneId("%3") }),
  );
  expect(decision).toEqual({ kind: "detach", client: "/dev/ttys001" });
});

test("an ordinary login to a machine murmur has jumped to still switches", () => {
  // The marker names ONE client. A second, human login to the same remote
  // session is not murmur-controlled, so PREFIX G there means "show me this
  // machine's dash" -- the spec's ordinary-remote-login case.
  expect(gotoDecision(world({ jumpClient: "/dev/ttys999 100" }))).toEqual({
    kind: "switch",
    pane: DASH,
  });
});

test("a marker for the same tty from an earlier client does not detach", () => {
  // Marker carries client_created precisely so a reused tty cannot inherit a
  // dead jump's identity: same name, different creation time, not us.
  expect(gotoDecision(world({ jumpClient: "/dev/ttys001 99" }))).toEqual({
    kind: "switch",
    pane: DASH,
  });
});

test("no dash running opens one", () => {
  expect(gotoDecision(world({ dashPane: null }))).toEqual({ kind: "spawn" });
});

test("a stale dash marker does not count as a running dash", () => {
  // The dash sets the option and clears it on exit, but a SIGKILL leaves it
  // behind. The pane is the liveness authority, as everywhere else in murmur.
  expect(gotoDecision(world({ livePanes: new Set([WORK.pane]) }))).toEqual({ kind: "spawn" });
});

test("an uninitialised node refuses rather than opening a dash that dies on start", () => {
  // The new window would close at once and take the error with it.
  const decision = gotoDecision(world({ dashPane: null, initialised: false }));
  expect(decision.kind === "fail" && decision.message).toContain("murmur init");
});

test("a pane list tmux could not answer is not evidence the dash is gone", () => {
  // null means "tmux did not answer", which must not be read as "no panes" --
  // and opening a second dash on that basis would duplicate a live one.
  expect(gotoDecision(world({ livePanes: null }))).toEqual({ kind: "switch", pane: DASH });
});

test("in the dash the key goes back to the recorded pane", () => {
  expect(gotoDecision(world({ here: IN_DASH, returnTo: WORK }))).toEqual({
    kind: "back",
    target: WORK.pane,
  });
});

test("back falls to the window when the pane is gone", () => {
  const decision = gotoDecision(
    world({ here: IN_DASH, returnTo: WORK, livePanes: new Set([DASH]) }),
  );
  expect(decision).toEqual({ kind: "back", target: WORK.window });
});

test("back with the window gone too stays in the dash and says so", () => {
  const decision = gotoDecision(
    world({
      here: IN_DASH,
      returnTo: WORK,
      livePanes: new Set([DASH]),
      liveWindows: new Set([DASH_WINDOW]),
    }),
  );
  expect(decision.kind === "fail" && decision.message).toContain("nothing to go back to");
});

test("back with no recorded place stays in the dash and says so", () => {
  const decision = gotoDecision(world({ here: IN_DASH }));
  expect(decision.kind === "fail" && decision.message).toContain("nothing to go back to");
});

test("detach outranks back inside a murmur jump session", () => {
  const decision = gotoDecision(
    world({ here: IN_DASH, returnTo: WORK, jumpClient: "/dev/ttys001 100" }),
  );
  expect(decision).toEqual({ kind: "detach", client: "/dev/ttys001" });
});

test("a return marker from an earlier client on the same tty is ignored", () => {
  // tty paths are recycled; the creation time is what makes the marker ours.
  expect(parseReturnMarker("99 %2 @2", "100")).toBeNull();
  expect(parseReturnMarker("100 %2 @2", "100")).toEqual(WORK);
  expect(parseReturnMarker("100 junk", "100")).toBeNull();
  expect(parseReturnMarker(null, "100")).toBeNull();
});

test("the return option name is one tmux option word per client", () => {
  expect(returnOption("/dev/ttys001")).toBe("@murmur_return__dev_ttys001");
});

test("outside tmux the command refuses", () => {
  const decision = gotoDecision(world({ insideTmux: false }));
  expect(decision.kind).toBe("fail");
  expect(decision.kind === "fail" && decision.message).toContain("inside tmux");
});

test("a client tmux cannot name can still switch to the dash", () => {
  // No client name means no way to match the jump marker, so the ordinary
  // switch is the honest answer rather than a refusal.
  expect(gotoDecision(world({ client: null, jumpClient: "/dev/ttys001 100" }))).toEqual({
    kind: "switch",
    pane: DASH,
  });
});

test("runGoto switches to the live dash pane", () => {
  const attached: string[] = [];
  const options: Record<string, string> = {};
  const result = runGoto(
    fakeMux({
      dashPane: () => DASH,
      livePanes: () => new Set([DASH]),
      clientIdentity: () => "/dev/ttys001 100",
      clientLocation: () => WORK,
      setOption: (name, value) => {
        options[name] = value;
      },
      attach: (pane) => {
        attached.push(pane);
        return true;
      },
    }),
    { TMUX: "/tmp/tmux-501/default,1,0" },
    OPTIONS,
  );
  expect(result).toEqual({ ok: true });
  expect(attached).toEqual([DASH]);
  // Where the key was pressed, recorded for the way back.
  expect(options).toEqual({ "@murmur_return__dev_ttys001": "100 %2 @2" });
});

test("runGoto in the dash switches back to the recorded pane", () => {
  const shown: string[] = [];
  const result = runGoto(
    fakeMux({
      dashPane: () => DASH,
      livePanes: () => new Set([DASH, WORK.pane]),
      clientIdentity: () => "/dev/ttys001 100",
      clientLocation: () => IN_DASH,
      option: (name) => (name === "@murmur_return__dev_ttys001" ? "100 %2 @2" : null),
      setOption: () => {
        throw new Error("going back must not overwrite the way back");
      },
      showTarget: (target) => {
        shown.push(target);
        return true;
      },
    }),
    { TMUX: "x" },
    OPTIONS,
  );
  expect(result).toEqual({ ok: true });
  expect(shown).toEqual([WORK.pane]);
});

test("runGoto with no dash opens one, marks it at once and switches to it", () => {
  const events: string[] = [];
  const result = runGoto(
    fakeMux({
      clientIdentity: () => "/dev/ttys001 100",
      clientLocation: () => WORK,
      openDash: (session, command) => {
        events.push(`open ${session} ${command.join(" ")}`);
        return asPaneId("%9");
      },
      markDashPane: (pane) => events.push(`mark ${pane}`),
      attach: (pane) => {
        events.push(`attach ${pane}`);
        return true;
      },
    }),
    { TMUX: "x" },
    OPTIONS,
  );
  expect(result).toEqual({ ok: true });
  expect(events).toEqual([`open ${DASH_SESSION} node murmur dash`, "mark %9", "attach %9"]);
});

test("runGoto detaches the marked jump client and never attaches", () => {
  const detached: string[] = [];
  const attached: string[] = [];
  const result = runGoto(
    fakeMux({
      dashPane: () => DASH,
      livePanes: () => new Set([DASH]),
      clientIdentity: () => "/dev/ttys001 100",
      jumpClientMarker: () => "/dev/ttys001 100",
      attach: (pane) => {
        attached.push(pane);
        return true;
      },
      detachClient: (client) => {
        detached.push(client);
        return true;
      },
    }),
    { TMUX: "/tmp/tmux-501/default,1,0" },
    OPTIONS,
  );
  expect(result).toEqual({ ok: true });
  expect(detached).toEqual(["/dev/ttys001"]);
  expect(attached).toEqual([]);
});

test("a failed tmux call is reported rather than swallowed", () => {
  const switchFailed = runGoto(
    fakeMux({
      dashPane: () => DASH,
      livePanes: () => new Set([DASH]),
      clientIdentity: () => "/dev/ttys001 100",
      attach: () => false,
    }),
    { TMUX: "x" },
    OPTIONS,
  );
  expect(switchFailed.ok).toBe(false);
  expect(switchFailed.ok === false && switchFailed.message).toContain("switch-client");

  const detachFailed = runGoto(
    fakeMux({
      dashPane: () => DASH,
      livePanes: () => new Set([DASH]),
      clientIdentity: () => "/dev/ttys001 100",
      jumpClientMarker: () => "/dev/ttys001 100",
      detachClient: () => false,
    }),
    { TMUX: "x" },
    OPTIONS,
  );
  expect(detachFailed.ok).toBe(false);
  expect(detachFailed.ok === false && detachFailed.message).toContain("detach-client");
});
