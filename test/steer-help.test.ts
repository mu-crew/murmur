import { Command } from "commander";
import { expect, test } from "vitest";
import { registerSteer } from "../src/cli/steer.js";

test("stop --help scopes the ctl abort to local tmux and says what pre-delivery failures omit", () => {
  const program = new Command();
  registerSteer(program);
  const stop = program.commands.find((c) => c.name() === "stop");
  let out = "";
  stop?.configureOutput({
    writeOut: (s) => {
      out += s;
    },
  });
  stop?.outputHelp();
  const help = out.replace(/\s+/g, " ");
  expect(help).toContain("in a local tmux pane is aborted over its ctl socket");
  expect(help).toContain("only ok, reason and message");
  expect(help).toContain("no action, jump_target, via, ctl_fallback, stopped or state");
});
