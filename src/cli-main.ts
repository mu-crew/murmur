import { Command } from "commander";
import { registerClear } from "./cli/clear.js";
import { registerCollect } from "./cli/collect.js";
import { registerDash } from "./cli/dash-register.js";
import { registerDoctor } from "./cli/doctor.js";
import { registerExport } from "./cli/export.js";
import { registerInit } from "./cli/init.js";
import { registerJumpCommand } from "./cli/jump-command.js";
import { registerNotify } from "./cli/notify.js";
import { registerPeer } from "./cli/peer.js";
import { registerPi } from "./cli/pi.js";
import { registerPick } from "./cli/pick-register.js";
import { registerSidepanel } from "./cli/sidepanel-register.js";
import { registerStatus } from "./cli/status.js";
import { StoreTooNewError, VERSION } from "./index.js";

// A store from a newer murmur is a version mismatch the user fixes by upgrading,
// not a crash: one line and exit 4, for sync and async actions alike, instead of
// a stack trace on every status-bar tick. Anything else keeps Node's default.
function tooNew(error: unknown): void {
  if (error instanceof StoreTooNewError) {
    process.stderr.write(`murmur: ${error.message}\n`);
    process.exit(4);
  }
  // What Node prints and returns without a handler (rethrowing here exits 7).
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
}
process.on("uncaughtException", tooNew);
process.on("unhandledRejection", tooNew);

const program = new Command();
program
  .name("murmur")
  .description("Agent state across every machine, in one view.")
  .version(VERSION);
registerInit(program);
registerPi(program);
registerJumpCommand(program);
registerExport(program);
registerCollect(program);
registerClear(program);
registerNotify(program);
registerPeer(program);
registerDoctor(program);
registerStatus(program);
registerDash(program);
registerSidepanel(program);
registerPick(program);
program.parse();
