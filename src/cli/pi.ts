import type { Command } from "commander";
import { migratePi } from "../pi-migrate.js";

export function registerPi(program: Command): void {
  const pi = program.command("pi").description("pi package helpers");
  pi.command("migrate")
    .description(
      "Move the old `murmur link pi` shim out of pi's discovery path (murmur-generated files only; nothing is deleted). Without --apply, report only. Install the package with: pi install npm:@mu-crew/murmur",
    )
    .option("--apply", "move the shim aside (default: report only)")
    .option("--json", "print the result as JSON")
    .action((options: { apply?: boolean; json?: boolean }) => {
      let r: ReturnType<typeof migratePi>;
      try {
        r = migratePi({ apply: options.apply === true });
      } catch (error) {
        // No global handler: a failed rename (EACCES, EXDEV) would otherwise be a
        // stack trace. The shim stays where it was, so nothing is half-moved.
        const message = error instanceof Error ? error.message : String(error);
        if (options.json === true) console.log(JSON.stringify({ error: message }));
        else process.stderr.write(`murmur: ${message}\n`);
        process.exitCode = 1;
        return;
      }
      if (options.json === true) {
        console.log(JSON.stringify(r));
        return;
      }
      const what = {
        absent: "not present",
        shim: "murmur-owned (not moved)",
        foreign: "not murmur's: left alone",
      }[r.state];
      console.log(
        r.moved ? `extension: moved ${r.path} -> ${r.to}` : `extension: ${r.path} ${what}`,
      );
      for (const line of r.guidance) console.log(line);
    });
}
