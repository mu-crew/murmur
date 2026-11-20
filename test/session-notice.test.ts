import { expect, test } from "vitest";
import { warmSocketCommand } from "../src/channel.js";
import { DASH_GLYPH } from "../src/dash-paint.js";
import { sessionNotice } from "../src/paint.js";
import type { Status } from "../src/status.js";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** What a reader sees: the notice minus its escape codes. */
function visible(text: string): string {
  return text.replace(ANSI, "");
}

/** A peer in the shape a lapsed interactive session leaves behind. */
function gated(name: string, fetchedAt: number | null): Status["peers"][number] {
  return {
    name,
    // Distinct from the name on purpose: `peer add <name> [target]` takes them
    // separately, so a remedy built from the name would not necessarily run.
    target: `${name}.invalid`,
    display_name: null,
    fetched_at: fetchedAt,
    snapshot_at: fetchedAt,
    last_error: "Permission denied (keyboard-interactive).",
    stale: true,
    needs_session: true,
  };
}

test("no notice when nothing needs a session", () => {
  // The line must be absent, not empty: an always-present header row would be
  // furniture in the common case, and the dash header has little room to spare.
  expect(sessionNotice([])).toBeNull();
  expect(sessionNotice([{ ...gated("host-a", 1_000), needs_session: false }])).toBeNull();
});

test("the notice names the peer, its age, and the exact command", () => {
  // Three facts the operator acts on: WHICH peer, HOW STALE the rows on screen
  // are, and the command that fixes it. The age is what answers "do I care right
  // now" without murmur inventing a staleness threshold.
  const notice = sessionNotice([gated("host-a", 1_000)], 1_000 + 3_600_000);

  expect(notice).toContain("host-a");
  expect(notice).toContain("1h");
  // The command that works on any machine, which is `-M` plus an explicit `-S`.
  // OpenSSH defaults to `ControlMaster no` and `ControlPath none`, so a plain
  // `ssh host-a` can leave no socket where murmur looks, and the notice used to
  // tell the reader to run the thing that had just failed them.
  // Asserted against the shared helper, so the suggestion cannot drift from the
  // ControlPath murmur actually uses.
  expect(notice).toContain(warmSocketCommand("host-a.invalid"));
  // And it names the TARGET, not the peer's local name.
  expect(notice).toContain("host-a.invalid");
});

test("a peer never reached reads as never, not as an age", () => {
  // `fetched_at` is null before the first successful collect, and "0m ago" would
  // be a lie about data that does not exist.
  const notice = sessionNotice([gated("host-a", null)], 5_000);

  expect(notice).toContain("never");
});

test("several gated peers collapse into one line, oldest first", () => {
  // One line, because the header cannot afford one per peer. Oldest first
  // because that is the one whose rows are most likely to mislead.
  const notice = sessionNotice(
    [gated("host-c", 900_000), gated("host-a", 1_000), gated("host-b", 500_000)],
    1_000_000,
  );

  // The exact joined list, not `/host-a.*host-b.*host-c/`. That pattern passes on
  // an UNSORTED notice too, because the remedy at the tail repeats the first
  // name -- verified by mutation: deleting the sort kept the loose regex green.
  expect(notice).toContain("host-a, host-b, host-c");
  expect(notice?.split("\n")).toHaveLength(1);
});

test("the peer list is trimmed rather than counted", () => {
  // Trimmed with no counter, per the spec: a truncated list plus "+3 more" is
  // more furniture than the header can afford, and `murmur doctor` carries the
  // full list for anyone who wants it.
  const many = Array.from({ length: 6 }, (_, index) => gated(`peer-${index}`, 1_000));

  const notice = sessionNotice(many, 5_000);

  expect(notice).not.toMatch(/\+\d|more|\(\d/);
  // VISIBLE width, not string length: the styling is ~30 escape bytes that
  // occupy no columns, and the raw length now exceeds any sane bound while the
  // line on screen is ~79 wide. Measuring the wrong one turned a real
  // regression signal into a false alarm.
  expect(visible(notice ?? "").length).toBeLessThan(120);
  // Trimmed, asserted by NAME. The length bound alone does not catch it: six
  // short fixture names fit inside 120 columns, so an untrimmed notice passed
  // it -- verified by mutation on `slice(0, NOTICE_PEERS)`.
  expect(notice).toContain("peer-2");
  expect(notice).not.toContain("peer-3");
});

test("the notice is styled as an action, not as furniture", () => {
  // It shipped DIM, which is paint.ts's code for scenery -- secondary facts and
  // labels wear it. The one header line asking the reader
  // to do something must not render in the same weight as the things they learn
  // once and stop seeing.
  //
  // Asserted on the escape codes because that IS the behaviour here: a notice
  // nobody notices has failed at its only job, and "we styled it" is not
  // provable from the text alone.
  const notice = sessionNotice([gated("host-a", 1_000)], 5_000) ?? "";

  // Bold, and `blocked`'s yellow -- COLOUR's vocabulary is "red needs you now,
  // peach needs you soon", and a lapsed login is the latter. Reusing that hue
  // keeps one meaning per colour rather than teaching a fourth.
  expect(notice).toContain("\u001b[1m");
  expect(notice).toContain("\u001b[33m");
  // Never dim.
  expect(notice).not.toContain("\u001b[2m");
  // And it carries `blocked`'s glyph, so it reads as that class of thing in the
  // alphabet the glyph column already established.
  expect(notice).toContain(DASH_GLYPH.blocked);
});
