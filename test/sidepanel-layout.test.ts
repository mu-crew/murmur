import { expect, test } from "vitest";
import { asPaneId } from "../src/ids.js";
import { reflowSidepanelAdded, reflowSidepanelRemoved } from "../src/sidepanel-layout.js";

const panel = asPaneId("%9");

test("addition makes the side panel a full-height fixed-width root child", () => {
  const afterSplit = "0000,120x40,0,0{25x20,0,0,9,94x40,26,0[94x19,26,0,1,94x20,26,20,2]}";

  expect(reflowSidepanelAdded(afterSplit, panel, 30)).toBe(
    "cf2c,120x40,0,0{30x40,0,0,9,89x40,31,0[89x19,31,0,1,89x20,31,20,2]}",
  );
});

test("addition scales a single content pane", () => {
  const afterSplit = "0000,120x40,0,0{25x40,0,0,9,94x40,26,0,1}";

  expect(reflowSidepanelAdded(afterSplit, panel, 30)).toBe(
    "ea71,120x40,0,0{30x40,0,0,9,89x40,31,0,1}",
  );
});

test("addition recursively scales a horizontal content split", () => {
  const afterSplit = "0000,120x40,0,0{25x40,0,0,9,94x40,26,0{47x40,26,0,1,46x40,74,0,2}}";

  expect(reflowSidepanelAdded(afterSplit, panel, 30)).toBe(
    "fc35,120x40,0,0{30x40,0,0,9,89x40,31,0{44x40,31,0,1,44x40,76,0,2}}",
  );
});

test("addition scales root content proportionally and assigns rounding remainder last", () => {
  const afterSplit = "0000,120x40,0,0{25x40,0,0,9,30x40,26,0,1,63x40,57,0,2}";
  const result = reflowSidepanelAdded(afterSplit, panel, 30);

  expect(result).toMatch(/^[0-9a-f]{4},120x40,0,0\{30x40,0,0,9,28x40,31,0,1,60x40,60,0,2\}$/);
});

test("addition scales nested horizontal and vertical trees", () => {
  const afterSplit =
    "0000,120x40,0,0{25x40,0,0,9,94x40,26,0[94x19,26,0{47x19,26,0,1,46x19,74,0,2},94x20,26,20,3]}";
  const result = reflowSidepanelAdded(afterSplit, panel, 30);

  expect(result).toMatch(
    /^[0-9a-f]{4},120x40,0,0\{30x40,0,0,9,89x40,31,0\[89x19,31,0\{44x19,31,0,1,44x19,76,0,2\},89x20,31,20,3\]\}$/,
  );
});

test("addition rejects an incompatible tree or impossible width", () => {
  const verticalRoot = "0000,120x40,0,0[120x10,0,0,9,120x29,0,11,1]";
  const nestedPanel = "0000,120x40,0,0{59x40,0,0[59x19,0,0,9,59x20,0,20,1],60x40,60,0,2}";
  const rootPanel = "0000,120x40,0,0{25x40,0,0,9,94x40,26,0,1}";

  expect(reflowSidepanelAdded(verticalRoot, panel, 30)).toBeNull();
  expect(reflowSidepanelAdded(nestedPanel, panel, 30)).toBeNull();
  expect(reflowSidepanelAdded(rootPanel, asPaneId("%99"), 30)).toBeNull();
  expect(reflowSidepanelAdded(rootPanel, panel, 119)).toBeNull();
  expect(reflowSidepanelAdded(rootPanel, panel, 0)).toBeNull();
});

test("removal expands a single remaining pane to the root", () => {
  const current = "0000,120x40,0,0{30x40,0,0,9,89x40,31,0,1}";

  expect(reflowSidepanelRemoved(current, panel)).toBe("aafe,120x40,0,0,1");
});

test("removal preserves vertical geometry", () => {
  const current = "0000,120x40,0,0{30x40,0,0,9,89x40,31,0[89x19,31,0,1,89x20,31,20,2]}";

  expect(reflowSidepanelRemoved(current, panel)).toBe(
    "562d,120x40,0,0[120x19,0,0,1,120x20,0,20,2]",
  );
});

test("removal uses the current split tree rather than a saved layout", () => {
  const splitWhileOpen = "0000,120x40,0,0{30x40,0,0,9,44x40,31,0,1,44x40,76,0,2}";

  expect(reflowSidepanelRemoved(splitWhileOpen, panel)).toBe(
    "7922,120x40,0,0{60x40,0,0,1,59x40,61,0,2}",
  );
});

test("removal prunes a nested panel and collapses one-child splits", () => {
  const current = "0000,120x40,0,0{59x40,0,0[59x19,0,0,9,59x20,0,20,1],60x40,60,0,2}";
  expect(reflowSidepanelRemoved(current, panel)).toBe("8112,120x40,0,0{59x40,0,0,1,60x40,60,0,2}");
});

test("add then remove preserves content topology and proportions modulo rounding", () => {
  const afterSplit = "0000,120x40,0,0{25x40,0,0,9,94x40,26,0{47x40,26,0,1,46x40,74,0,2}}";
  const added = reflowSidepanelAdded(afterSplit, panel, 30);

  expect(added).not.toBeNull();
  expect(reflowSidepanelRemoved(added ?? "", panel)).toBe(
    "7922,120x40,0,0{60x40,0,0,1,59x40,61,0,2}",
  );
});

test("malformed, trailing, and missing-pane layouts are rejected", () => {
  expect(reflowSidepanelAdded("bad", panel, 30)).toBeNull();
  expect(reflowSidepanelAdded("0000,10x10,0,0,1junk", asPaneId("%1"), 3)).toBeNull();
  expect(reflowSidepanelRemoved("zzzz,10x10,0,0,1", asPaneId("%1"))).toBeNull();
  expect(reflowSidepanelRemoved("0000,10x10,0,0,1", panel)).toBeNull();
  expect(reflowSidepanelRemoved("0000,10x10,0,0{},1", panel)).toBeNull();
});
