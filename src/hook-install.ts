// `murmur init`'s hook half, and what `murmur doctor` checks: murmur's entries
// in each hook harness's own config file.
//
// Those files are shared. mu, museum and muzzle write their own hooks into the
// same `~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.cursor/hooks.json`
// and Muse settings, and so does the user. So murmur owns exactly the handlers
// whose command starts with `murmur`, and nothing else: every other handler,
// group, matcher and key is left as it was found, in place. A file murmur
// cannot read as the shape it expects is reported and never rewritten.
//
// One plan serves both verbs. `init` writes the plan when it changes something;
// `doctor` reports the same plan as drift. A file whose plan is empty is not
// rewritten at all, so a second `init` changes nothing, not even formatting.

import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { ensureDir } from "./dirs.js";
import type { Harness } from "./harnesses.js";

/** The harnesses `murmur init` writes hook entries for: every hook row's. */
export type HookHarness = Exclude<Harness, "pi">;

/**
 * How a config file nests its handlers.
 *
 * - `grouped`: Claude Code's `hooks.<Event>[].hooks[]`, where each group may
 *   carry a `matcher`. codex and Muse's settings use it too.
 * - `flat`: the Cursor CLI's `hooks.<event>[]`, handlers directly, beside a
 *   top-level `version`.
 */
type Shape = "grouped" | "flat";

type HookTarget = {
  readonly harness: HookHarness;
  /** The config file, relative to the home directory. */
  readonly file: readonly string[];
  /**
   * The directory whose presence says the harness is set up on this machine,
   * relative to the home directory. Without `--hooks`, `init` writes only where
   * it exists, so a machine with no Cursor CLI grows no `~/.cursor`.
   */
  readonly dir: readonly string[];
  readonly shape: Shape;
  /** The hooked events, in the order new entries are appended. */
  readonly events: readonly string[];
  /** Events whose handler must be declared `async: true`. */
  readonly async: readonly string[];
};

/**
 * Every hook harness's file and events: the ones its `murmur hook` row maps,
 * and no others. `PreToolUse`/`PostToolUse` fire on every tool call and carry
 * nothing murmur uses, so they are never hooked.
 *
 * Muse's `Interrupt` is delivered only to a handler declared async, and only
 * through the `hooks` key of its settings (a Claude-format plugin cannot
 * subscribe to it), which is why Muse is written there and nowhere else.
 */
export const HOOK_TARGETS: readonly HookTarget[] = Object.freeze([
  {
    harness: "claude",
    file: [".claude", "settings.json"],
    dir: [".claude"],
    shape: "grouped",
    events: [
      "SessionStart",
      "UserPromptSubmit",
      "PermissionRequest",
      "Notification",
      "Stop",
      "StopFailure",
      "SessionEnd",
    ],
    async: [],
  },
  {
    harness: "codex",
    file: [".codex", "hooks.json"],
    dir: [".codex"],
    shape: "grouped",
    events: [
      "SessionStart",
      "UserPromptSubmit",
      "PermissionRequest",
      "Stop",
      "Interrupt",
      "SessionEnd",
    ],
    async: [],
  },
  {
    harness: "cursor-agent",
    file: [".cursor", "hooks.json"],
    dir: [".cursor"],
    shape: "flat",
    events: ["sessionStart", "beforeSubmitPrompt", "afterAgentResponse", "stop", "sessionEnd"],
    async: [],
  },
  {
    harness: "muse",
    file: [".config", "muse", "settings.json"],
    dir: [".config", "muse"],
    shape: "grouped",
    events: [
      "SessionStart",
      "UserPromptSubmit",
      "PermissionRequest",
      "Stop",
      "StopFailure",
      "Interrupt",
      "SessionEnd",
    ],
    async: ["Interrupt"],
  },
] satisfies HookTarget[]);

export const HOOK_HARNESSES: readonly HookHarness[] = HOOK_TARGETS.map((t) => t.harness);

export function isHookHarness(value: string): value is HookHarness {
  return (HOOK_HARNESSES as readonly string[]).includes(value);
}

/** The command murmur's entries run for one harness. */
export function hookCommand(harness: HookHarness): string {
  return `murmur hook ${harness}`;
}

/**
 * Whether a handler's command is murmur's to manage: its first word is
 * `murmur`. A command that runs murmur by absolute path, or through a wrapper,
 * is the user's, and is left alone.
 */
export function isMurmurCommand(command: unknown): boolean {
  return typeof command === "string" && /^murmur(?:\s|$)/.test(command.trimStart());
}

/** The home directory hook configs live under. Tests and sandboxes redirect it. */
export function hookHome(): string {
  return process.env.MURMUR_HOOK_HOME ?? homedir();
}

/** What bringing one file in line with murmur's entries takes. */
export type HookPlan = {
  /** murmur-owned handlers found before any change. */
  owned: number;
  /** Events that had no usable murmur handler, and get one. */
  added: string[];
  /** murmur handlers kept but corrected in place (`Interrupt: async`). */
  fixed: string[];
  /** murmur handlers removed, as `<event>: <command>`. */
  removed: string[];
};

/** The file holds something murmur will not guess its way through. */
class Unworkable extends Error {}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A group whose matcher lets every event of its kind through. */
function matchesAll(group: Json): boolean {
  return group.matcher === undefined || group.matcher === "" || group.matcher === "*";
}

/**
 * The handler list one event's entries hold, as `[container, list]` pairs:
 * each group's `hooks` for the grouped shape, the event's own list for the flat
 * one. A group that is not murmur's shape is skipped, not refused: it cannot
 * hold a handler murmur would recognise.
 */
function handlerLists(shape: Shape, entries: unknown[]): { group: Json | null; list: unknown[] }[] {
  if (shape === "flat") return [{ group: null, list: entries }];
  return entries
    .filter((group): group is Json => isObject(group) && Array.isArray(group.hooks))
    .map((group) => ({ group, list: group.hooks as unknown[] }));
}

/**
 * Bring `root`, one parsed config file, in line with murmur's entries, in
 * place, and say what that took.
 *
 * Per hooked event the first murmur handler that is exactly the one murmur
 * writes is kept, wherever it sits, with any field the user added. A missing
 * `async: true` (or a missing `type` in the grouped shape) is set on it. Every
 * other murmur handler is removed: a duplicate, an older form (the Cursor CLI's
 * `murmur notify --source cursor`, which would report a turn twice), a handler
 * under a matcher that filters the event, one on an event murmur does not
 * hook. A group or event list that held only murmur handlers goes with them.
 * Any hooked event left without a handler gets a new group (or entry) at the
 * end of its list.
 */
export function planHooks(target: HookTarget, root: Json): HookPlan {
  const plan: HookPlan = { owned: 0, added: [], fixed: [], removed: [] };
  if (root.hooks !== undefined && !isObject(root.hooks)) {
    throw new Unworkable("its `hooks` is not an object");
  }
  const hooks: Json = isObject(root.hooks) ? root.hooks : {};
  const command = hookCommand(target.harness);
  const kept = new Set<string>();

  for (const event of Object.keys(hooks)) {
    const entries = hooks[event];
    const hooked = target.events.includes(event);
    if (!Array.isArray(entries)) {
      if (hooked) throw new Unworkable(`its \`hooks.${event}\` is not a list`);
      continue;
    }
    const removedBefore = plan.removed.length;
    for (const { group, list } of handlerLists(target.shape, entries)) {
      const before = list.length;
      for (let i = 0; i < list.length; i++) {
        const handler = list[i];
        if (!isObject(handler) || !isMurmurCommand(handler.command)) continue;
        plan.owned++;
        const usable =
          hooked &&
          !kept.has(event) &&
          handler.command === command &&
          (group === null || matchesAll(group)) &&
          (target.shape === "flat" || handler.type === undefined || handler.type === "command");
        if (usable) {
          kept.add(event);
          if (target.shape === "grouped" && handler.type === undefined) {
            handler.type = "command";
            plan.fixed.push(`${event}: type`);
          }
          if (target.async.includes(event) && handler.async !== true) {
            handler.async = true;
            plan.fixed.push(`${event}: async`);
          }
          continue;
        }
        plan.removed.push(`${event}: ${String(handler.command)}`);
        list.splice(i, 1);
        i--;
      }
      // A group murmur emptied goes too; one that was already empty is not murmur's.
      if (group !== null && before > 0 && list.length === 0) {
        entries.splice(entries.indexOf(group), 1);
      }
    }
    if (entries.length === 0 && plan.removed.length > removedBefore) delete hooks[event];
  }

  for (const event of target.events) {
    if (kept.has(event)) continue;
    const handler: Json =
      target.shape === "flat"
        ? { command }
        : {
            type: "command",
            command,
            ...(target.async.includes(event) ? { async: true } : {}),
          };
    const entry = target.shape === "flat" ? handler : { hooks: [handler] };
    const entries = hooks[event];
    if (Array.isArray(entries)) entries.push(entry);
    else hooks[event] = [entry];
    plan.added.push(event);
  }

  if (plan.added.length > 0 || plan.fixed.length > 0 || plan.removed.length > 0) {
    root.hooks = hooks;
    // The Cursor CLI reads no hook file without its schema version.
    if (target.shape === "flat" && root.version === undefined) root.version = 1;
  }
  return plan;
}

function changed(plan: HookPlan): boolean {
  return plan.added.length > 0 || plan.fixed.length > 0 || plan.removed.length > 0;
}

/** One read of a config file: its parsed root, and the bytes it was read from. */
type Read = {
  root: Json;
  /** The file's text, or null when it does not exist. */
  text: string | null;
};

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Unworkable(`cannot read it: ${(error as Error).message}`);
  }
}

/** The parsed file, `{}` when it does not exist. Throws Unworkable on anything else. */
function readConfig(path: string): Read {
  const text = readText(path);
  if (text === null || text.trim() === "") return { root: {}, text };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Unworkable(`it is not valid JSON: ${(error as Error).message}`);
  }
  if (!isObject(parsed)) throw new Unworkable("it is not a JSON object");
  return { root: parsed, text };
}

/**
 * The file a write to `path` must replace: the end of its symlink chain, so a
 * dotfiles checkout keeps its link. A link whose target does not exist yet
 * still names where the file belongs, and the target is created there.
 */
function writeTarget(path: string): string {
  let current = path;
  for (let hops = 0; hops < 40; hops++) {
    let link: boolean;
    try {
      link = lstatSync(current).isSymbolicLink();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return current;
      throw new Unworkable(`cannot read it: ${(error as Error).message}`);
    }
    if (!link) return current;
    current = resolve(dirname(current), readlinkSync(current));
  }
  throw new Unworkable("its symlinks loop");
}

/** How many times a write that raced another writer is planned again. */
const WRITE_ATTEMPTS = 3;

/**
 * Test seam: runs after the new contents are staged and before the re-read
 * that guards the rename, so a test can play the other writer. Never set
 * outside tests.
 */
let beforeCommit: ((path: string) => void) | undefined;

export function setBeforeCommitForTests(hook: ((path: string) => void) | undefined): void {
  beforeCommit = hook;
}

/** The file changed under murmur between its read and its write. */
class Raced extends Error {}

/**
 * Replace the file's contents in one rename, through a symlink to its target,
 * with the target's permissions.
 *
 * The file is shared, and its other writers (the harness itself, mu, museum,
 * muzzle) do not lock it either, so just before the rename the file is read
 * again: if it is no longer the text the plan was made from, nothing is
 * written and Raced is thrown, so the caller plans again from the new text
 * rather than overwrite another writer's change.
 */
function writeConfig(path: string, root: Json, readFrom: string | null): void {
  const real = writeTarget(path);
  ensureDir(dirname(real));
  let mode = 0o600;
  try {
    mode = statSync(real).mode & 0o777;
  } catch {
    // New file: settings can carry secrets, so owner-only.
  }
  const tmp = join(dirname(real), `.${basename(real)}.murmur-${process.pid}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(root, null, 2)}\n`, { mode });
    beforeCommit?.(path);
    if (readText(real) !== readFrom) throw new Raced();
    renameSync(tmp, real);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * The config file whose codex `notify` array still runs murmur, the older way
 * to report a finished codex turn, or null. With murmur's hooks in
 * `hooks.json` as well, every finished turn is reported twice.
 *
 * Read-only: murmur never edits codex's TOML. A plain text match is enough for
 * the forms murmur's docs gave, `["murmur", "notify", ...]` and the
 * `/bin/sh -lc "exec murmur notify ..."` wrapper; a commented-out line does
 * not count.
 */
export function codexNotifyRunsMurmur(home: string = hookHome()): string | null {
  const path = join(home, ".codex", "config.toml");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  for (const match of text.matchAll(/^[ \t]*notify[ \t]*=[ \t]*\[([^\]]*)\]/gm)) {
    if (/\bmurmur\b/.test(match[1] ?? "")) return path;
  }
  return null;
}

export type HookInstallState =
  /** The harness's directory is not there and it was not asked for. */
  | "skipped"
  /** murmur's entries were already right; the file was not touched. */
  | "unchanged"
  | "written"
  /** The file could not be read as murmur expects; it was not touched. */
  | "refused";

export type HookInstallResult = {
  harness: HookHarness;
  path: string;
  state: HookInstallState;
  added: string[];
  fixed: string[];
  removed: string[];
  /** Why the file was refused, or failed to write. */
  error?: string;
  /**
   * codex only, once its hooks are in place: the `config.toml` whose `notify`
   * line still runs murmur, so a finished turn is reported twice.
   */
  notifyConfig?: string;
};

function targetPaths(target: HookTarget, home: string): { path: string; dir: string } {
  return { path: join(home, ...target.file), dir: join(home, ...target.dir) };
}

/**
 * Add or update murmur's entries in each hook harness's config file.
 *
 * `harnesses` names the ones to write, creating their files; without it, each
 * harness whose config directory exists is written and the rest are skipped.
 * One harness's failure never stops the others.
 */
export function installHooks(
  opts: { home?: string; harnesses?: readonly HookHarness[] } = {},
): HookInstallResult[] {
  const home = opts.home ?? hookHome();
  return HOOK_TARGETS.map((target) => {
    const { path, dir } = targetPaths(target, home);
    const result: HookInstallResult = {
      harness: target.harness,
      path,
      state: "skipped",
      added: [],
      fixed: [],
      removed: [],
    };
    const wanted = opts.harnesses
      ? opts.harnesses.includes(target.harness)
      : existsSync(dir) || existsSync(path);
    if (!wanted) return result;
    try {
      result.state = writeHooks(target, path, result);
    } catch (error) {
      result.state = "refused";
      result.error = error instanceof Error ? error.message : String(error);
      return result;
    }
    if (target.harness === "codex") {
      const notify = codexNotifyRunsMurmur(home);
      if (notify !== null) result.notifyConfig = notify;
    }
    return result;
  });
}

/**
 * Plan and write one file, planning again from the new text when another
 * writer changed it meanwhile. The plan's lists land on `result`.
 */
function writeHooks(
  target: HookTarget,
  path: string,
  result: Pick<HookInstallResult, "added" | "fixed" | "removed">,
): "unchanged" | "written" {
  for (let attempt = 1; ; attempt++) {
    const { root, text } = readConfig(path);
    const plan = planHooks(target, root);
    Object.assign(result, { added: plan.added, fixed: plan.fixed, removed: plan.removed });
    if (!changed(plan)) return "unchanged";
    try {
      writeConfig(path, root, text);
      return "written";
    } catch (error) {
      if (!(error instanceof Raced)) throw error;
      if (attempt >= WRITE_ATTEMPTS) {
        throw new Unworkable("another program kept changing it; run `murmur init` again");
      }
    }
  }
}

export type HookCheckState =
  /** murmur's entries are exactly what `init` writes. */
  | "ok"
  /** Some murmur entries, not the ones `init` writes. */
  | "drift"
  /** The harness is set up here, but no murmur entry is in its file. */
  | "unhooked"
  /** The file could not be read as murmur expects. */
  | "unreadable";

export type HookCheck = {
  harness: HookHarness;
  path: string;
  state: HookCheckState;
  added: string[];
  fixed: string[];
  removed: string[];
  error?: string;
  /** As on HookInstallResult: codex's `config.toml` still running murmur from `notify`. */
  notifyConfig?: string;
};

/**
 * murmur's entries in each hook harness's config, as `init` would leave them.
 * Read-only. A harness whose config directory and file are both absent is
 * not set up here and is not reported.
 */
export function checkHooks(opts: { home?: string } = {}): HookCheck[] {
  const home = opts.home ?? hookHome();
  const checks: HookCheck[] = [];
  for (const target of HOOK_TARGETS) {
    const { path, dir } = targetPaths(target, home);
    if (!existsSync(dir) && !existsSync(path)) continue;
    const check: HookCheck = {
      harness: target.harness,
      path,
      state: "ok",
      added: [],
      fixed: [],
      removed: [],
    };
    try {
      const plan = planHooks(target, readConfig(path).root);
      Object.assign(check, { added: plan.added, fixed: plan.fixed, removed: plan.removed });
      check.state = plan.owned === 0 ? "unhooked" : changed(plan) ? "drift" : "ok";
      // Only once codex runs murmur's hooks: before that, `notify` is how its
      // turns are reported at all.
      if (target.harness === "codex" && check.state !== "unhooked") {
        const notify = codexNotifyRunsMurmur(home);
        if (notify !== null) check.notifyConfig = notify;
      }
    } catch (error) {
      check.state = "unreadable";
      check.error = error instanceof Error ? error.message : String(error);
    }
    checks.push(check);
  }
  return checks;
}

/** One check's difference from what `init` writes, as a short clause. */
export function describeDrift(check: Pick<HookCheck, "added" | "fixed" | "removed">): string {
  const parts: string[] = [];
  if (check.added.length > 0) parts.push(`missing ${check.added.join(", ")}`);
  if (check.fixed.length > 0) parts.push(`needs ${check.fixed.join(", ")}`);
  if (check.removed.length > 0) parts.push(`stray ${check.removed.join(", ")}`);
  return parts.join("; ");
}
