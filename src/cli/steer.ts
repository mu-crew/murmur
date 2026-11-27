import { readFileSync } from "node:fs";
import type { Command } from "commander";

type Options = { json?: boolean };

const STOP_HELP = `
A mu pi agent is aborted over its ctl socket, but only once the socket's hello
names the pane's own agent and workstream; any other pane gets Escape. The
pane's state is then read back for up to 5s: delivery alone is not success.

--json prints one object; exit 0 exactly when ok is true, else 1:
  ok            true only when the pane was seen to leave working
  action        "stop"
  jump_target   the token given
  via           "ctl" | "escape"
  ctl_fallback  null when via is "ctl", else not_local | not_pi | no_identity |
                no_socket | no_answer | identity_mismatch | abort_failed
  stopped       true (left working) | false (still working) | null (unreadable)
  state         crashed|error|blocked|done|running|waiting|idle|gone, or null
  reason        on failure: not_stopped | unconfirmed | delivery_failed |
                invalid_target | not_found (the last three carry no via/stopped/state)
  message       on failure: one line saying why

See ARCHITECTURE.md#contract.`;

/** `murmur prompt` and `murmur stop`: steer an agent by its `jump_target`. */
export function registerSteer(program: Command): void {
  program
    .command("prompt")
    .description("Send a prompt to an agent by the jump_target from `status --json`")
    .argument("<target>", "opaque panes[].jump_target token")
    .argument("[text]", "prompt text, or - to read it from stdin")
    .option("--json", "print one JSON receipt for success or failure")
    .action(async (target: string, text: string | undefined, options: Options) => {
      const { runSteerCommand } = await import("./steer-run.js");
      const body = text === "-" ? readFileSync(0, "utf8").replace(/\r?\n$/, "") : (text ?? "");
      await runSteerCommand("prompt", target, body, options);
    });
  program
    .command("stop")
    .description("Interrupt an agent by the jump_target from `status --json`")
    .argument("<target>", "opaque panes[].jump_target token")
    .option("--json", "print one JSON receipt for success or failure")
    .action(async (target: string, options: Options) => {
      const { runSteerCommand } = await import("./steer-run.js");
      await runSteerCommand("stop", target, "", options);
    })
    .addHelpText("after", STOP_HELP);
}
