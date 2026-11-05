import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { render } from "../src/cli/doctor.js";
import { describeInstall, describeNotifyConflict, parseHookList } from "../src/cli/init.js";
import { diagnose } from "../src/doctor.js";
import {
  checkHooks,
  codexNotifyRunsMurmur,
  HOOK_TARGETS,
  hookHome,
  installHooks,
  isMurmurCommand,
  setBeforeCommitForTests,
} from "../src/hook-install.js";
import { mapHookPayload } from "../src/hook-rows.js";
import { builtArtifact } from "./helpers/built.js";

/**
 * `murmur init`'s hook entries and `murmur doctor`'s check of them.
 *
 * The files are shared with mu, museum, muzzle and the user, so the contract
 * under test is ownership: murmur adds and updates only handlers whose command
 * starts with `murmur`, and a second run changes nothing. Every test runs
 * against a temporary home directory; none can reach the real one.
 */

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "murmur-hook-home-"));
});

afterEach(() => {
  setBeforeCommitForTests(undefined);
  rmSync(home, { recursive: true, force: true });
});

const CLAUDE = [".claude", "settings.json"];
const CODEX = [".codex", "hooks.json"];
const CURSOR = [".cursor", "hooks.json"];
const MUSE = [".config", "muse", "settings.json"];

function file(parts: string[]): string {
  return join(home, ...parts);
}

function put(parts: string[], value: unknown): void {
  const path = file(parts);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

// biome-ignore lint/suspicious/noExplicitAny: test reads arbitrary parsed JSON
function read(parts: string[]): any {
  return JSON.parse(readFileSync(file(parts), "utf8"));
}

/** Every handler command under one event of a grouped file. */
function grouped(parts: string[], event: string): string[] {
  const entries = (read(parts).hooks?.[event] ?? []) as { hooks: { command: string }[] }[];
  return entries.flatMap((group) => group.hooks.map((handler) => handler.command));
}

const FOREIGN_SESSION_START = {
  matcher: "startup",
  hooks: [{ type: "command", command: "mu hook session-start", timeout: 30 }],
};

describe("the acceptance check", () => {
  test("init twice leaves a foreign SessionStart entry intact and adds nothing the second time", () => {
    put(CLAUDE, {
      model: "opus",
      hooks: { SessionStart: [FOREIGN_SESSION_START] },
    });

    const first = installHooks({ home }).find((r) => r.harness === "claude");
    expect(first?.state).toBe("written");
    expect(first?.added).toContain("SessionStart");
    const afterFirst = readFileSync(file(CLAUDE), "utf8");
    const parsed = JSON.parse(afterFirst);
    expect(parsed.model).toBe("opus");
    expect(parsed.hooks.SessionStart[0]).toEqual(FOREIGN_SESSION_START);
    expect(grouped(CLAUDE, "SessionStart")).toEqual([
      "mu hook session-start",
      "murmur hook claude",
    ]);

    const inode = statSync(file(CLAUDE)).ino;
    const second = installHooks({ home }).find((r) => r.harness === "claude");
    expect(second).toMatchObject({ state: "unchanged", added: [], fixed: [], removed: [] });
    // Not rewritten at all: same bytes, same file.
    expect(readFileSync(file(CLAUDE), "utf8")).toBe(afterFirst);
    expect(statSync(file(CLAUDE)).ino).toBe(inode);
    expect(read(CLAUDE).hooks.SessionStart[0]).toEqual(FOREIGN_SESSION_START);
  });
});

describe("what init writes", () => {
  test("each harness gets its own command on exactly the events its hook row maps", () => {
    for (const dir of [".claude", ".codex", ".cursor", ".config/muse"]) {
      mkdirSync(join(home, dir), { recursive: true });
    }
    const results = installHooks({ home });
    expect(results.map((r) => r.state)).toEqual(["written", "written", "written", "written"]);

    expect(Object.keys(read(CLAUDE).hooks)).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "PermissionRequest",
      "Notification",
      "Stop",
      "StopFailure",
      "SessionEnd",
    ]);
    expect(grouped(CLAUDE, "Stop")).toEqual(["murmur hook claude"]);
    expect(read(CLAUDE).hooks.Stop).toEqual([
      { hooks: [{ type: "command", command: "murmur hook claude" }] },
    ]);

    expect(Object.keys(read(CODEX).hooks)).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "PermissionRequest",
      "Stop",
      "Interrupt",
      "SessionEnd",
    ]);
    expect(grouped(CODEX, "Interrupt")).toEqual(["murmur hook codex"]);

    const cursor = read(CURSOR);
    expect(cursor.version).toBe(1);
    expect(cursor.hooks.stop).toEqual([{ command: "murmur hook cursor-agent" }]);
    expect(Object.keys(cursor.hooks)).toEqual([
      "sessionStart",
      "beforeSubmitPrompt",
      "afterAgentResponse",
      "stop",
      "sessionEnd",
    ]);

    // Muse delivers `Interrupt` only to a handler declared async.
    const muse = read(MUSE);
    expect(Object.keys(muse.hooks)).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "PermissionRequest",
      "Stop",
      "StopFailure",
      "Interrupt",
      "SessionEnd",
    ]);
    expect(muse.hooks.Interrupt).toEqual([
      { hooks: [{ type: "command", command: "murmur hook muse", async: true }] },
    ]);
    expect(muse.hooks.Stop[0].hooks[0].async).toBeUndefined();
  });

  test("a harness is hooked on an event exactly when its row maps that event", () => {
    // Ties the install table to the rows, both ways: an event init hooks that
    // the row drops costs a hook call per event for nothing, and an event the
    // row maps that init does not hook is lost.
    const candidates = new Set([
      ...HOOK_TARGETS.flatMap((target) => target.events),
      "SubagentStop",
      "PreToolUse",
      "PostToolUse",
      "PreCompact",
      "Notification",
      "afterShellExecution",
      "beforeShellExecution",
    ]);
    for (const target of HOOK_TARGETS) {
      for (const event of candidates) {
        const payload = {
          hook_event_name: event,
          session_id: "s",
          transcript_path: "/t",
          status: "completed",
          text: "x",
          message: "needs your permission to use Bash",
          notification_type: "permission_prompt",
        };
        expect(
          target.events.includes(event),
          `${target.harness} ${event}: hooked must equal mapped`,
        ).toBe(mapHookPayload(target.harness, payload) !== null);
      }
    }
  });

  test("a harness not set up here is skipped, and --hooks writes it anyway", () => {
    expect(installHooks({ home }).map((r) => r.state)).toEqual([
      "skipped",
      "skipped",
      "skipped",
      "skipped",
    ]);
    expect(existsSync(join(home, ".cursor"))).toBe(false);

    const results = installHooks({ home, harnesses: ["cursor-agent"] });
    expect(results.find((r) => r.harness === "cursor-agent")?.state).toBe("written");
    expect(results.find((r) => r.harness === "claude")?.state).toBe("skipped");
    expect(read(CURSOR).hooks.sessionEnd).toEqual([{ command: "murmur hook cursor-agent" }]);
    // New files are owner-only: settings can hold secrets.
    expect(statSync(file(CURSOR)).mode & 0o777).toBe(0o600);
  });

  test("the home directory comes from MURMUR_HOOK_HOME, which the suite points at a sandbox", () => {
    expect(hookHome()).toBe(process.env.MURMUR_HOOK_HOME);
    expect(hookHome().startsWith(tmpdir())).toBe(true);
  });
});

describe("ownership", () => {
  test("only commands whose first word is murmur are murmur's", () => {
    expect(isMurmurCommand("murmur hook claude")).toBe(true);
    expect(isMurmurCommand("  murmur notify --source cursor")).toBe(true);
    expect(isMurmurCommand("murmur")).toBe(true);
    expect(isMurmurCommand("murmurx hook claude")).toBe(false);
    expect(isMurmurCommand("/usr/local/bin/murmur hook claude")).toBe(false);
    expect(isMurmurCommand("mu hook stop")).toBe(false);
    expect(isMurmurCommand("muzzle hook claude")).toBe(false);
    expect(isMurmurCommand(undefined)).toBe(false);
  });

  test("other tools' handlers, groups and keys are left exactly where they were", () => {
    const foreignStop = {
      hooks: [
        { type: "command", command: "mu hook stop", timeout: 600 },
        { type: "command", command: "museum hook claude" },
      ],
    };
    const preTool = {
      matcher: "Bash",
      hooks: [{ type: "command", command: "muzzle hook claude" }],
    };
    put(CLAUDE, {
      permissions: { allow: ["Bash(ls)"] },
      hooks: {
        PreToolUse: [preTool],
        Stop: [foreignStop],
        SessionStart: [FOREIGN_SESSION_START],
      },
    });
    installHooks({ home });
    const after = read(CLAUDE);
    expect(after.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(after.hooks.PreToolUse).toEqual([preTool]);
    expect(after.hooks.Stop[0]).toEqual(foreignStop);
    expect(after.hooks.Stop[1]).toEqual({
      hooks: [{ type: "command", command: "murmur hook claude" }],
    });
    // Existing keys keep their order; new ones are appended.
    expect(Object.keys(after.hooks).slice(0, 3)).toEqual(["PreToolUse", "Stop", "SessionStart"]);
  });

  test("a murmur handler already in a shared group is kept in place, with the user's extra fields", () => {
    put(CLAUDE, {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: "mu hook stop" },
              { type: "command", command: "murmur hook claude", timeout: 5 },
            ],
          },
        ],
      },
    });
    const result = installHooks({ home }).find((r) => r.harness === "claude");
    expect(result?.added).not.toContain("Stop");
    expect(read(CLAUDE).hooks.Stop).toEqual([
      {
        hooks: [
          { type: "command", command: "mu hook stop" },
          { type: "command", command: "murmur hook claude", timeout: 5 },
        ],
      },
    ]);
  });

  test("stale murmur handlers are removed, and only murmur's", () => {
    put(CLAUDE, {
      hooks: {
        // An event murmur does not hook.
        PreToolUse: [{ hooks: [{ type: "command", command: "murmur hook claude" }] }],
        // A duplicate, and the wrong harness's command, beside a foreign handler.
        Stop: [
          { hooks: [{ type: "command", command: "murmur hook claude" }] },
          {
            hooks: [
              { type: "command", command: "murmur hook claude" },
              { type: "command", command: "murmur hook codex" },
              { type: "command", command: "mu hook stop" },
            ],
          },
        ],
        // A matcher that would filter the event: replaced by an unfiltered group.
        SessionStart: [
          { matcher: "startup", hooks: [{ type: "command", command: "murmur hook claude" }] },
        ],
      },
    });
    const result = installHooks({ home }).find((r) => r.harness === "claude");
    expect(result?.removed).toEqual([
      "PreToolUse: murmur hook claude",
      "Stop: murmur hook claude",
      "Stop: murmur hook codex",
      "SessionStart: murmur hook claude",
    ]);
    const after = read(CLAUDE);
    expect(after.hooks.PreToolUse).toBeUndefined();
    expect(after.hooks.Stop).toEqual([
      { hooks: [{ type: "command", command: "murmur hook claude" }] },
      { hooks: [{ type: "command", command: "mu hook stop" }] },
    ]);
    expect(after.hooks.SessionStart).toEqual([
      { hooks: [{ type: "command", command: "murmur hook claude" }] },
    ]);
  });

  test("the Cursor CLI's older notify entry gives way, other handlers stay", () => {
    put(CURSOR, {
      version: 1,
      hooks: {
        stop: [{ command: "murmur notify --source cursor" }, { command: "./audit.sh" }],
        beforeShellExecution: [{ command: "muzzle hook cursor" }],
      },
    });
    const result = installHooks({ home }).find((r) => r.harness === "cursor-agent");
    expect(result?.removed).toEqual(["stop: murmur notify --source cursor"]);
    const after = read(CURSOR);
    expect(after.hooks.stop).toEqual([
      { command: "./audit.sh" },
      { command: "murmur hook cursor-agent" },
    ]);
    expect(after.hooks.beforeShellExecution).toEqual([{ command: "muzzle hook cursor" }]);
  });

  test("a murmur Interrupt handler in Muse settings is made async in place", () => {
    put(MUSE, {
      theme: "dark",
      hooks: {
        Interrupt: [{ hooks: [{ type: "command", command: "murmur hook muse" }] }],
      },
    });
    const result = installHooks({ home }).find((r) => r.harness === "muse");
    expect(result?.fixed).toEqual(["Interrupt: async"]);
    expect(read(MUSE).theme).toBe("dark");
    expect(read(MUSE).hooks.Interrupt).toEqual([
      { hooks: [{ type: "command", command: "murmur hook muse", async: true }] },
    ]);
    expect(installHooks({ home }).find((r) => r.harness === "muse")?.state).toBe("unchanged");
  });

  test("a kept grouped handler without a type gets `type: command`; another type is replaced", () => {
    put(CLAUDE, {
      hooks: {
        Stop: [{ hooks: [{ command: "murmur hook claude", timeout: 5 }] }],
        SessionStart: [{ hooks: [{ type: "prompt", command: "murmur hook claude" }] }],
      },
    });
    const result = installHooks({ home }).find((r) => r.harness === "claude");
    expect(result?.fixed).toEqual(["Stop: type"]);
    expect(result?.removed).toEqual(["SessionStart: murmur hook claude"]);
    expect(result?.added).toContain("SessionStart");
    const after = read(CLAUDE);
    expect(after.hooks.Stop).toEqual([
      { hooks: [{ command: "murmur hook claude", timeout: 5, type: "command" }] },
    ]);
    expect(after.hooks.SessionStart).toEqual([
      { hooks: [{ type: "command", command: "murmur hook claude" }] },
    ]);
  });

  test("a file already right is never reformatted", () => {
    mkdirSync(join(home, ".claude"));
    installHooks({ home });
    // The same content, compacted by hand: still right, so still untouched.
    const compact = JSON.stringify(read(CLAUDE));
    writeFileSync(file(CLAUDE), compact);
    expect(installHooks({ home }).find((r) => r.harness === "claude")?.state).toBe("unchanged");
    expect(readFileSync(file(CLAUDE), "utf8")).toBe(compact);
  });
});

describe("files murmur will not rewrite", () => {
  test("invalid JSON, a non-object root or a non-object hooks is refused untouched", () => {
    for (const text of ["{ not json", "[1, 2]", '{"hooks": []}', '{"hooks": {"Stop": {}}}']) {
      put(CLAUDE, text);
      const result = installHooks({ home }).find((r) => r.harness === "claude");
      expect(result?.state, text).toBe("refused");
      expect(result?.error, text).toBeTruthy();
      expect(readFileSync(file(CLAUDE), "utf8"), text).toBe(text);
    }
  });

  test("one refused file does not stop the others", () => {
    put(CLAUDE, "{ not json");
    mkdirSync(join(home, ".codex"));
    const results = installHooks({ home });
    expect(results.find((r) => r.harness === "claude")?.state).toBe("refused");
    expect(results.find((r) => r.harness === "codex")?.state).toBe("written");
  });

  test("a symlink to a file not there yet keeps its link; the target is created", () => {
    const target = join(home, "dotfiles", "claude", "settings.json");
    mkdirSync(join(home, ".claude"));
    symlinkSync(target, file(CLAUDE));

    expect(installHooks({ home }).find((r) => r.harness === "claude")?.state).toBe("written");
    expect(lstatSync(file(CLAUDE)).isSymbolicLink()).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(grouped(CLAUDE, "Stop")).toEqual(["murmur hook claude"]);
  });

  test("a symlinked config keeps its link; the target is updated with its mode", () => {
    const target = join(home, "dotfiles", "claude-settings.json");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify({ hooks: {} }), { mode: 0o640 });
    mkdirSync(join(home, ".claude"));
    symlinkSync(target, file(CLAUDE));

    expect(installHooks({ home }).find((r) => r.harness === "claude")?.state).toBe("written");
    expect(lstatSync(file(CLAUDE)).isSymbolicLink()).toBe(true);
    expect(statSync(target).mode & 0o777).toBe(0o640);
    expect(grouped(CLAUDE, "Stop")).toEqual(["murmur hook claude"]);
  });
});

describe("a writer racing init", () => {
  test("a change made between murmur's read and its write is kept, and the plan redone", () => {
    put(CLAUDE, { hooks: {} });
    let raced = false;
    setBeforeCommitForTests((path) => {
      if (raced) return;
      raced = true;
      // The harness itself saves a setting meanwhile.
      writeFileSync(path, JSON.stringify({ model: "opus", hooks: {} }));
    });
    const result = installHooks({ home }).find((r) => r.harness === "claude");
    expect(result?.state).toBe("written");
    expect(read(CLAUDE).model).toBe("opus");
    expect(grouped(CLAUDE, "Stop")).toEqual(["murmur hook claude"]);
    // No staged temp file is left beside it.
    expect(readdirSync(join(home, ".claude"))).toEqual(["settings.json"]);
  });

  test("a file that keeps changing is refused after a few tries, never overwritten", () => {
    put(CLAUDE, { hooks: {} });
    let n = 0;
    setBeforeCommitForTests((path) => {
      n++;
      writeFileSync(path, JSON.stringify({ n, hooks: {} }));
    });
    const result = installHooks({ home }).find((r) => r.harness === "claude");
    expect(result?.state).toBe("refused");
    expect(result?.error).toMatch(/run `murmur init` again/);
    expect(n).toBe(3);
    expect(read(CLAUDE)).toEqual({ n: 3, hooks: {} });
    expect(readdirSync(join(home, ".claude"))).toEqual(["settings.json"]);
  });
});

describe("codex's older notify line", () => {
  const CONFIG = [".codex", "config.toml"];

  test("is found only when a notify array runs murmur and is not commented out", () => {
    expect(codexNotifyRunsMurmur(home)).toBe(null);
    put(CONFIG, 'model = "o3"\nnotify = ["murmur", "notify", "--source", "codex"]\n');
    expect(codexNotifyRunsMurmur(home)).toBe(file(CONFIG));
    put(CONFIG, 'notify = [\n  "/bin/sh",\n  "-lc",\n  "exec murmur notify --source codex",\n]\n');
    expect(codexNotifyRunsMurmur(home)).toBe(file(CONFIG));
    put(CONFIG, '# notify = ["murmur", "notify"]\nnotify = ["./my-notify.sh"]\n');
    expect(codexNotifyRunsMurmur(home)).toBe(null);
  });

  test("init and doctor flag it once codex is hooked, and leave config.toml alone", () => {
    const toml = 'notify = ["murmur", "notify", "--source", "codex"]\n';
    put(CONFIG, toml);

    // Not hooked yet: notify is how codex reports at all, so nothing to flag.
    const before = checkHooks({ home }).find((c) => c.harness === "codex");
    expect(before?.state).toBe("unhooked");
    expect(before?.notifyConfig).toBeUndefined();

    const result = installHooks({ home }).find((r) => r.harness === "codex");
    expect(result?.state).toBe("written");
    expect(result?.notifyConfig).toBe(file(CONFIG));
    expect(installHooks({ home }).find((r) => r.harness === "codex")?.notifyConfig).toBe(
      file(CONFIG),
    );
    expect(readFileSync(file(CONFIG), "utf8")).toBe(toml);

    const findings = diagnose(
      { host_id: "SELF", display_name: "laptop", peers: [], hooks: checkHooks({ home }) },
      [],
    );
    expect(findings.map((f) => [f.kind, f.severity, f.subject, f.remedy])).toEqual([
      ["reported-twice", "problem", "codex", null],
    ]);
    expect(findings[0]?.detail).toContain(file(CONFIG));
    expect(render({ host_id: "SELF", display_name: "laptop", peers: [] }, [], findings)).toContain(
      "Reported twice",
    );
  });
});

describe("doctor", () => {
  test("checks read each harness set up here as ok, drift, unhooked or unreadable", () => {
    expect(checkHooks({ home })).toEqual([]);

    mkdirSync(join(home, ".claude"));
    mkdirSync(join(home, ".codex"));
    installHooks({ home, harnesses: ["claude", "muse"] });
    put(CURSOR, "{ broken");
    // Drift: Muse's Interrupt loses its async, and its Stop goes.
    const muse = read(MUSE);
    delete muse.hooks.Interrupt[0].hooks[0].async;
    delete muse.hooks.Stop;
    put(MUSE, muse);

    const checks = checkHooks({ home });
    expect(checks.map((c) => [c.harness, c.state])).toEqual([
      ["claude", "ok"],
      ["codex", "unhooked"],
      ["cursor-agent", "unreadable"],
      ["muse", "drift"],
    ]);
    const drift = checks.find((c) => c.harness === "muse");
    expect(drift?.added).toEqual(["Stop"]);
    expect(drift?.fixed).toEqual(["Interrupt: async"]);
    // Read-only: the drifted file is still drifted.
    expect(read(MUSE).hooks.Stop).toBeUndefined();
  });

  test("drift is a problem with `murmur init` as the fix; no hooks is an observation", () => {
    mkdirSync(join(home, ".codex"));
    put(CLAUDE, {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "murmur hook claude" }] }] },
    });
    const findings = diagnose(
      { host_id: "SELF", display_name: "laptop", peers: [], hooks: checkHooks({ home }) },
      [],
    );
    expect(findings.map((f) => [f.kind, f.severity, f.subject, f.remedy])).toEqual([
      ["hook-drift", "problem", "claude", "murmur init"],
      ["hooks-absent", "observation", "codex", "murmur init"],
    ]);
    expect(findings[0]?.detail).toContain("missing SessionStart");

    // With no peers the node's own findings are still printed, not swallowed.
    const output = render({ host_id: "SELF", display_name: "laptop", peers: [] }, [], findings);
    expect(output).toContain("No peers configured, so only this node was checked.");
    expect(output).toContain("Hook drift");
    expect(output).toContain("Harnesses without murmur hooks");
    expect(output).toContain("murmur init");

    installHooks({ home });
    expect(
      diagnose(
        { host_id: "SELF", display_name: "laptop", peers: [], hooks: checkHooks({ home }) },
        [],
      ),
    ).toEqual([]);
  });

  test("an unreadable config is a problem with no command to run", () => {
    put(CODEX, "nope");
    const [finding] = diagnose(
      { host_id: "SELF", display_name: "laptop", peers: [], hooks: checkHooks({ home }) },
      [],
    );
    expect(finding).toMatchObject({ kind: "hook-drift", severity: "problem", remedy: null });
  });
});

describe("the CLI", () => {
  test("--hooks names harnesses or all, and refuses anything else", () => {
    expect(parseHookList("claude,muse")).toEqual(["claude", "muse"]);
    expect(parseHookList("all")).toEqual(["claude", "codex", "cursor-agent", "muse"]);
    expect(parseHookList("pi")).toMatch(/--hooks takes/);
    expect(parseHookList("")).toMatch(/--hooks takes/);
    expect(parseHookList("all,claud")).toMatch(/--hooks takes/);
    expect(parseHookList("muse,all")).toEqual(["claude", "codex", "cursor-agent", "muse"]);
    expect(
      describeInstall({
        harness: "codex",
        path: "/h/.codex/hooks.json",
        state: "written",
        added: ["Stop"],
        fixed: [],
        removed: [],
      }),
    ).toBe("hooks codex: added Stop in /h/.codex/hooks.json (codex asks you to trust them once)");
  });

  /** The built CLI with HOME at the temp home, and murmur's own override removed. */
  function cli(args: string[]) {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    delete env.MURMUR_HOOK_HOME;
    return spawnSync(process.execPath, [builtArtifact("cli.js"), ...args], {
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
  }

  test("init writes under HOME, twice is a no-op, and doctor then reports nothing for hooks", () => {
    put(CLAUDE, { hooks: { SessionStart: [FOREIGN_SESSION_START] } });
    mkdirSync(join(home, ".config", "muse"), { recursive: true });

    const first = cli(["init"]);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain(`hooks claude: added SessionStart`);
    expect(first.stdout).toContain(`hooks cursor-agent: not set up here`);
    expect(read(MUSE).hooks.Interrupt[0].hooks[0].async).toBe(true);
    const bytes = readFileSync(file(CLAUDE), "utf8");

    const second = cli(["init"]);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain(`hooks claude: up to date in ${file(CLAUDE)}`);
    expect(second.stdout).toContain(`hooks muse: up to date in ${file(MUSE)}`);
    expect(readFileSync(file(CLAUDE), "utf8")).toBe(bytes);
    expect(read(CLAUDE).hooks.SessionStart[0]).toEqual(FOREIGN_SESSION_START);

    const doctor = cli(["doctor", "--json"]);
    expect(doctor.status, doctor.stderr).toBe(0);
    const report = JSON.parse(doctor.stdout) as { findings: { kind: string }[] };
    expect(report.findings.filter((f) => f.kind.startsWith("hook"))).toEqual([]);

    // Drift, introduced by hand, is a doctor problem: exit 1.
    const claude = read(CLAUDE);
    delete claude.hooks.Stop;
    put(CLAUDE, claude);
    const drifted = cli(["doctor", "--json"]);
    expect(drifted.status).toBe(1);
    expect(JSON.parse(drifted.stdout).findings).toContainEqual(
      expect.objectContaining({ kind: "hook-drift", subject: "claude", remedy: "murmur init" }),
    );
  });

  test("--no-hooks and a mistyped --hooks write nothing", () => {
    mkdirSync(join(home, ".claude"));
    expect(cli(["init", "--no-hooks"]).status).toBe(0);
    expect(existsSync(file(CLAUDE))).toBe(false);

    const typo = cli(["init", "--hooks", "claud"]);
    expect(typo.status).toBe(1);
    expect(typo.stderr).toMatch(/^murmur: --hooks takes/);
    expect(existsSync(file(CLAUDE))).toBe(false);

    const named = cli(["init", "--hooks", "cursor-agent"]);
    expect(named.status, named.stderr).toBe(0);
    expect(read(CURSOR).hooks.stop).toEqual([{ command: "murmur hook cursor-agent" }]);
    // Named harnesses only: claude, though set up, was not asked for.
    expect(existsSync(file(CLAUDE))).toBe(false);
  });

  test("init warns on stderr about codex's notify line, and still exits 0", () => {
    put([".codex", "config.toml"], 'notify = ["murmur", "notify", "--source", "codex"]\n');
    const run = cli(["init"]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("hooks codex: added");
    expect(run.stderr).toContain(
      `murmur: ${describeNotifyConflict(join(home, ".codex", "config.toml"))}`,
    );
  });

  test("a refused file is one line on stderr and exit 1, and the rest still run", () => {
    put(CLAUDE, "{ not json");
    mkdirSync(join(home, ".codex"));
    const run = cli(["init"]);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/^murmur: hooks claude: left .* untouched: it is not valid JSON/);
    expect(run.stderr).not.toContain("    at ");
    expect(run.stdout).toContain("hooks codex: added");
    expect(readFileSync(file(CLAUDE), "utf8")).toBe("{ not json");
  });
});
