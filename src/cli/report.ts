import type { Command } from "commander";
import { type HookContext, type MuHookTarget, muHookEvent } from "../hook.js";
import { type InboxEvent, type InboxRuntime, parseRuntime } from "../inbox-event.js";
import { writeInboxEvent } from "../inbox-file.js";
import { context, resolvePane } from "./hook.js";
import { paneServer } from "./pane.js";

/**
 * `murmur report`: a script or harness murmur has no hook row for says what it
 * runs with. One `runtime_reported` event in the pane's inbox, placed like
 * `murmur hook`; best effort, so it warns and exits 0 whatever is wrong.
 */

/** Commander's value for an option declared `[value]` and given none. */
type Given<T> = T | true;

export type ReportFlags = {
  model?: string;
  provider?: string;
  effort?: string;
  contextPct?: string;
  contextTokens?: string;
  contextWindow?: string;
};

const FLAG_NAMES: Record<keyof ReportFlags, string> = {
  model: "--model",
  provider: "--provider",
  effort: "--effort",
  contextPct: "--context-pct",
  contextTokens: "--context-tokens",
  contextWindow: "--context-window",
};

/** The runtime the flags name, each valid flag kept; `warnings` says what was skipped. */
export function reportRuntime(flags: ReportFlags): { runtime: InboxRuntime; warnings: string[] } {
  const warnings: string[] = [];
  const raw: Record<string, unknown> = {};
  const number = (text: string): number => (/^\d+(\.\d+)?$/.test(text.trim()) ? Number(text) : NaN);
  const given = (Object.keys(FLAG_NAMES) as (keyof ReportFlags)[]).filter(
    (key) => flags[key] !== undefined,
  );
  for (const key of given) {
    const value = flags[key] as string;
    if (key === "model" || key === "provider" || key === "effort") raw[key] = value;
    else {
      raw[
        key === "contextPct"
          ? "context_pct"
          : key === "contextTokens"
            ? "context_tokens"
            : "context_window"
      ] = number(value);
    }
  }
  const runtime = parseRuntime(raw);
  const kept = {
    model: "model" in runtime,
    provider: "provider" in runtime,
    effort: "effort" in runtime || "provider_effort" in runtime,
    contextPct: "context_pct" in runtime,
    contextTokens: "context_tokens" in runtime,
    contextWindow: "context_window" in runtime,
  };
  for (const key of given) {
    if (!kept[key])
      warnings.push(`${FLAG_NAMES[key]}: invalid value ${JSON.stringify(flags[key])}, skipped`);
  }
  return { runtime, warnings };
}

/** The report event, placed, or the reason it cannot be. */
export function reportEvent(
  runtime: InboxRuntime,
  target: MuHookTarget | null,
  found: HookContext,
): InboxEvent | string {
  const event = muHookEvent(
    {
      event: "runtime_reported",
      harness: null,
      agent: null,
      by: "harness",
      session_id: null,
      source: null,
      reason: null,
      message: null,
      text: null,
      generation_id: null,
      runtime,
    },
    found,
    target,
  );
  if (typeof event === "string") return event;
  // pi reports its own runtime in-process.
  if (event.harness === "pi") return "pi reports its own runtime";
  return event;
}

export function registerReport(program: Command): void {
  // Tolerant parsing, for `report` only: every option takes an optional value
  // and unknown options are allowed, so a malformed command line reaches the
  // action, which warns, skips what it cannot use and exits 0.
  program
    .command("report")
    .description("Report the model, provider, effort and context a harness runs with")
    .allowUnknownOption()
    .allowExcessArguments()
    .option("--pane [pane]", "the pane the report is about (default: the pane it runs in)")
    .option("--model [id]", "model id")
    .option("--provider [name]", "model provider")
    .option("--effort [level]", "reasoning effort")
    .option("--context-pct [n]", "context window used, 0-100")
    .option("--context-tokens [n]", "context tokens used")
    .option("--context-window [n]", "context window size in tokens")
    .option("-L, --socket-name [name]", "tmux server socket name, with --pane")
    .option("-S, --socket-path [path]", "tmux server socket path, with --pane")
    .action(
      (
        raw: { [K in keyof ReportFlags]?: Given<string> } & {
          pane?: Given<string>;
          socketName?: Given<string>;
          socketPath?: Given<string>;
        },
        command: Command,
      ) => {
        const warn = (message: string): void => {
          process.stderr.write(`murmur: report: ${message}\n`);
        };
        try {
          // An option given no value is a missing argument: warn and skip it.
          const options: ReportFlags & { pane?: string; socketName?: string; socketPath?: string } =
            {};
          for (const [key, value] of Object.entries(raw)) {
            if (value === true) {
              const flag = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
              warn(`--${flag}: argument missing, skipped`);
            } else if (typeof value === "string") {
              (options as Record<string, string>)[key] = value;
            }
          }
          for (const arg of command.args) {
            warn(
              `${arg.startsWith("-") ? "unknown option" : "unexpected argument"} ${arg}, skipped`,
            );
          }
          const { runtime, warnings } = reportRuntime(options);
          for (const message of warnings) warn(message);
          if (Object.keys(runtime).length === 0) {
            warn("nothing to report");
            return;
          }
          let target: MuHookTarget | null = null;
          if (options.pane !== undefined) {
            if (!/^%\d+$/.test(options.pane)) {
              warn(`not a tmux pane id: ${options.pane}`);
              return;
            }
            const resolved = resolvePane(options.pane, paneServer(options));
            if (typeof resolved === "string") {
              warn(resolved);
              return;
            }
            target = resolved;
          }
          const found = context();
          if (!found) {
            warn("could not read the process table");
            return;
          }
          const event = reportEvent(runtime, target, found);
          if (typeof event === "string") warn(event);
          else if (!writeInboxEvent(event)) warn("the event could not be written to the inbox");
        } catch (error) {
          warn(error instanceof Error ? error.message : String(error));
        }
      },
    );
}
