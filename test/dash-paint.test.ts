import { expect, test } from "vitest";
import { DASH_CHROME, DASH_CHROME_COLOR, DASH_COLOR, DASH_GLYPH } from "../src/dash-paint.js";
import { GLYPH } from "../src/paint.js";
import { RENDER_PRIORITY } from "../src/view.js";

test("every render state has its single-codepoint Nerd Font glyph", () => {
  expect(DASH_GLYPH).toEqual({
    crashed: "\uf057",
    error: "\uf071",
    blocked: "\uf075",
    done: "\uf058",
    running: "\uf04b",
    waiting: "\uf252",
    idle: "\uf186",
  });
  for (const state of RENDER_PRIORITY) {
    expect([...DASH_GLYPH[state]]).toHaveLength(1);
    // One family: Nerd Font nf-fa-* (Font Awesome 4), U+F000..U+F2E0. Never an
    // emoji, which renders double-width and in colour beside its neighbours.
    const cp = DASH_GLYPH[state].codePointAt(0) ?? 0;
    expect(cp >= 0xf000 && cp <= 0xf2e0, `${state} U+${cp.toString(16)}`).toBe(true);
  }
  expect(GLYPH).toBe(DASH_GLYPH);
});

test("dash state colors use the Catppuccin Mocha palette", () => {
  expect(DASH_COLOR).toEqual({
    crashed: "#f38ba8",
    error: "#eba0ac",
    blocked: "#fab387",
    done: "#94e2d5",
    running: "#a6adc8",
    waiting: "#74c7ec",
    idle: "#6c7086",
  });
});

test("dash chrome uses Nerd Font glyphs and Catppuccin accents", () => {
  expect(DASH_CHROME).toEqual({
    robot: "\u{f06a9}",
    here: "\uf015",
    remote: "\uf233",
    crew: "\uf0c0",
    stale: "\uf017",
  });
  expect(DASH_CHROME_COLOR).toEqual({
    here: "#a6e3a1",
    remote: "#74c7ec",
    stale: "#f9e2af",
    furniture: "#6c7086",
    selectedFallback: "#b4befe",
    accent: "#cba6f7",
    text: "#cdd6f4",
    info: "#89b4fa",
  });
});
