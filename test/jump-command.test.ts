import { expect, test } from "vitest";
import { defaultJumpCommand, renderJumpCommand } from "../src/jump-command.js";

test("the default gives the remote tmux client a UTF-8 locale", () => {
  expect(renderJumpCommand(defaultJumpCommand("p"), "%9")).toBe(
    "ssh -t 'p' env LC_CTYPE=C.UTF-8 tmux attach -t ''\\''%9'\\'''",
  );
});

test("a custom jump command substitutes the pane id", () => {
  expect(renderJumpCommand('et dev -c "tmux attach -t {pane}"', "%42")).toBe(
    'et dev -c "tmux attach -t %42"',
  );
});
