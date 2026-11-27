import { expect, test } from "vitest";
import { asPaneId } from "../src/ids.js";
import { jumpTarget, parseJumpTarget } from "../src/jump-target.js";
import type { TmuxServer } from "../src/types.js";

test.each<[TmuxServer, string]>([
  [{ kind: "default" }, "%1"],
  [{ kind: "label", value: "my socket" }, "%2"],
  [{ kind: "path", value: "/tmp/tmux-501/x" }, "%3"],
  [{ kind: "rex" }, "block:01a21c58-9b2f-73bd-98d3-2f653ab4b233"],
])("a %j jump target parses back to its address", (server, pane) => {
  const address = { host_id: "h", server, pane: asPaneId(pane) };
  expect(parseJumpTarget(jumpTarget(address))).toEqual(address);
});

test("a server of unknown kind is not a valid jump target", () => {
  const token = `j1:${Buffer.from(JSON.stringify(["h", { kind: "zellij" }, "%1"])).toString("base64url")}`;
  expect(parseJumpTarget(token)).toBeNull();
});
