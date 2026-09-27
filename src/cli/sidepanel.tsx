import { Box, render, Text, useApp, useInput, useWindowSize } from "ink";
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type JumpResult, jumpToAgent } from "../agents.js";
import { ssh } from "../channel.js";
import { COLLECT_FLOOR_MS } from "../collector.js";
import { DASH_CHROME_COLOR, DASH_COLOR } from "../dash-paint.js";
import { type DashPrefs, loadDashPrefs, saveDashPrefs } from "../dash-prefs.js";
import { type DashStore, openDashStore, refreshDashStore } from "../dash-store.js";
import type { FooterHint } from "../dash-tick.js";
import {
  closeSidepanel,
  type SidepanelOrigin,
  type SidepanelResult,
  sidepanelOrigin,
} from "../sidepanel-controller.js";
import {
  moveSidepanelSelection,
  sidepanelPaneKey,
  sidepanelRows,
  sidepanelWindow,
} from "../sidepanel-view.js";
import { type Status, status, statusWithCollect } from "../status.js";
import type { Store } from "../store.js";
import type { PaneView } from "../view.js";
import { requireIdentity } from "./identity-guard.js";

const REDRAW_MS = 3_000;
const FOOTER = "? help";

export type SidepanelHelpSection = { title: string; hints: FooterHint[] };

export function sidepanelHelpSections(view: {
  crew: boolean;
  compact: boolean;
}): SidepanelHelpSection[] {
  return [
    {
      title: "navigation",
      hints: [
        { chord: "j/↓", label: "next" },
        { chord: "k/↑", label: "previous" },
        { chord: "g/home", label: "top" },
        { chord: "G/end", label: "bottom" },
        { chord: "enter", label: "jump" },
      ],
    },
    {
      title: "view",
      hints: [
        { chord: "a", label: "crew only", value: view.crew ? "on" : "off" },
        { chord: "c", label: "compact", value: view.compact ? "on" : "off" },
      ],
    },
    {
      title: "panel",
      hints: [
        { chord: "q/^c", label: "close" },
        { chord: "?/esc", label: "close this help" },
      ],
    },
  ];
}

type SidepanelInputAction =
  | { type: "move"; key: "j" | "k" | "g" | "G" }
  | { type: "crew" }
  | { type: "compact" }
  | { type: "help-open" | "help-close" }
  | { type: "close" }
  | { type: "activate" }
  | { type: "none" };

export function routeSidepanelInput(
  helpOpen: boolean,
  input: string,
  key: {
    ctrl?: boolean;
    escape?: boolean;
    return?: boolean;
    downArrow?: boolean;
    upArrow?: boolean;
    home?: boolean;
    end?: boolean;
  },
  hasSelection: boolean,
): SidepanelInputAction {
  if (helpOpen) {
    return input === "?" || key.escape ? { type: "help-close" } : { type: "none" };
  }
  if (input === "?") return { type: "help-open" };
  if (input === "q" || (key.ctrl && input === "c")) return { type: "close" };
  if (input === "j" || key.downArrow) return { type: "move", key: "j" };
  if (input === "k" || key.upArrow) return { type: "move", key: "k" };
  if (input === "g" || key.home) return { type: "move", key: "g" };
  if (input === "G" || key.end) return { type: "move", key: "G" };
  if (input === "a") return { type: "crew" };
  if (input === "c") return { type: "compact" };
  if (key.return && hasSelection) return { type: "activate" };
  return { type: "none" };
}

export function reconcileSidepanelSelection(
  rows: ReturnType<typeof sidepanelRows>,
  selectedKey: string | null,
  fallbackIndex: number,
): { key: string | null; index: number } {
  const matching = rows.findIndex((row) => row.key === selectedKey);
  const index = matching < 0 ? Math.min(fallbackIndex, Math.max(0, rows.length - 1)) : matching;
  return { key: rows[index]?.key ?? null, index };
}

export function toggleSidepanelCrew(
  prefs: DashPrefs,
  save: (updated: DashPrefs) => void,
): DashPrefs {
  const updated = { ...prefs, crew: !prefs.crew };
  save(updated);
  return updated;
}

export function toggleSidepanelCompact(
  prefs: DashPrefs,
  save: (updated: DashPrefs) => void,
): DashPrefs {
  const updated = { ...prefs, compact: !prefs.compact };
  save(updated);
  return updated;
}

export function SidepanelHelp({ prefs }: { prefs: DashPrefs }) {
  return (
    <Box
      borderStyle="double"
      borderColor={DASH_CHROME_COLOR.accent}
      flexDirection="column"
      flexGrow={1}
      paddingX={1}
      overflow="hidden"
    >
      <Text bold color={DASH_CHROME_COLOR.accent}>
        shortcuts<Text dimColor> · ? or esc closes</Text>
      </Text>
      {sidepanelHelpSections({ crew: prefs.crew, compact: prefs.compact }).map((section) => (
        <Box key={section.title} flexDirection="column">
          <Text bold color={DASH_CHROME_COLOR.info}>
            {section.title}
          </Text>
          {section.hints.map((hint) => (
            <Text key={hint.chord} wrap="truncate-end">
              <Text color={DASH_CHROME_COLOR.accent}>{hint.chord.padEnd(7)}</Text>
              <Text dimColor>{hint.label}</Text>
              {hint.value ? <Text> {hint.value}</Text> : null}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}

export type SidepanelActionDeps = {
  jump?: (store: Store, selected: PaneView) => JumpResult;
  close?: typeof closeSidepanel;
  save?: (prefs: DashPrefs) => void;
  refresh?: (dashStore: DashStore) => Promise<Status>;
};

export class SidepanelRefreshTracker {
  private readonly active = new Set<Promise<void>>();

  track(refresh: Promise<void>): void {
    this.active.add(refresh);
    void refresh.finally(() => this.active.delete(refresh));
  }

  async settle(): Promise<void> {
    await Promise.allSettled([...this.active]);
  }
}

export async function activateSidepanelSelection(
  store: Store,
  selected: PaneView,
  origin: SidepanelOrigin,
  deps: SidepanelActionDeps = {},
): Promise<{ close: boolean; error: string | null }> {
  const jumped = (deps.jump ?? jumpToAgent)(store, selected);
  if (!jumped.ok) return { close: false, error: jumped.message };

  const closed = (deps.close ?? closeSidepanel)(origin.window, origin.pane);
  return { close: closed.ok, error: closed.ok ? null : closed.message };
}

type SidepanelProps = {
  dashStore: DashStore;
  initial: Status;
  origin: SidepanelOrigin;
  deps?: SidepanelActionDeps;
  initialPrefs?: DashPrefs;
  now?: number;
  dimensions?: { columns: number; rows: number };
  refreshTracker?: SidepanelRefreshTracker;
};

export function selectedSidepanelPane(
  panes: PaneView[],
  rows: ReturnType<typeof sidepanelRows>,
  index: number,
): PaneView | undefined {
  const row = rows[index];
  return row ? panes.find((pane) => sidepanelPaneKey(pane) === row.key) : undefined;
}

export function App({
  dashStore,
  initial,
  origin,
  deps = {},
  initialPrefs,
  now: initialNow,
  dimensions,
  refreshTracker,
}: SidepanelProps): ReactElement {
  const { exit } = useApp();
  const terminal = useWindowSize();
  const { columns, rows: terminalRows } = dimensions ?? terminal;
  const [view, setView] = useState(initial);
  const [prefs, setPrefs] = useState(initialPrefs ?? loadDashPrefs);
  const [now, setNow] = useState(initialNow ?? Date.now());
  const [selectedKey, setSelectedKey] = useState<string | null>(
    initial.panes[0] ? sidepanelPaneKey(initial.panes[0]) : null,
  );
  const [fallbackIndex, setFallbackIndex] = useState(0);
  const [message, setMessage] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  const mounted = useRef(false);
  const rows = useMemo(() => sidepanelRows(view.panes, prefs, now), [view.panes, prefs, now]);
  const selection = reconcileSidepanelSelection(rows, selectedKey, fallbackIndex);
  const selectedIndex = selection.index;
  const selected = selectedSidepanelPane(view.panes, rows, selectedIndex);
  const window = sidepanelWindow(
    selectedIndex,
    rows.length,
    terminalRows - 2 - (message ? 1 : 0),
    prefs.compact,
  );
  const shown = rows.slice(window.first, window.first + window.shown);

  useEffect(() => {
    if (selection.key !== selectedKey) setSelectedKey(selection.key);
  }, [selection.key, selectedKey]);

  const refresh = useCallback(() => {
    const task = (async () => {
      try {
        let updated: Status;
        if (deps.refresh) {
          updated = await deps.refresh(dashStore);
        } else {
          const identity = requireIdentity();
          if (!identity) return;
          refreshDashStore(dashStore);
          updated = await statusWithCollect(dashStore.store, identity, Date.now(), ssh, {
            floorMs: COLLECT_FLOOR_MS,
          });
        }
        if (!mounted.current) return;
        setView(updated);
        setNow(Date.now());
      } catch (error) {
        if (mounted.current) setMessage(error instanceof Error ? error.message : String(error));
      }
    })();
    refreshTracker?.track(task);
    return task;
  }, [dashStore, deps.refresh, refreshTracker]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const redraw = setInterval(() => {
      const identity = requireIdentity();
      if (!identity) return;
      const at = Date.now();
      try {
        refreshDashStore(dashStore);
        setView(status(dashStore.store, identity, at));
        setNow(at);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
    }, REDRAW_MS);
    const collect = setInterval(() => void refresh(), COLLECT_FLOOR_MS);
    return () => {
      mounted.current = false;
      clearInterval(redraw);
      clearInterval(collect);
    };
  }, [dashStore, refresh]);

  const close = useCallback(() => {
    const result: SidepanelResult = (deps.close ?? closeSidepanel)(origin.window, origin.pane);
    if (result.ok) exit();
    else setMessage(result.message);
  }, [deps.close, exit, origin]);

  useInput((input, key) => {
    const action = routeSidepanelInput(helpOpen, input, key, selected !== undefined);
    if (action.type === "help-open") {
      setHelpOpen(true);
    } else if (action.type === "help-close") {
      setHelpOpen(false);
    } else if (action.type === "close") {
      close();
    } else if (action.type === "move") {
      const index = moveSidepanelSelection(selectedIndex, action.key, rows.length);
      setFallbackIndex(index);
      setSelectedKey(rows[index]?.key ?? null);
    } else if (action.type === "crew") {
      setPrefs((current) => toggleSidepanelCrew(current, deps.save ?? saveDashPrefs));
    } else if (action.type === "compact") {
      setPrefs((current) => toggleSidepanelCompact(current, deps.save ?? saveDashPrefs));
    } else if (action.type === "activate" && selected) {
      void activateSidepanelSelection(dashStore.store, selected, origin, deps).then((result) => {
        setMessage(result.error ?? "");
        if (result.close) exit();
      });
    }
  });

  return (
    <Box flexDirection="column" width={columns} height={terminalRows} overflow="hidden">
      <Text bold color={DASH_CHROME_COLOR.accent} wrap="truncate-end">
        {`murmur · ${rows.length} ${rows.length === 1 ? "agent" : "agents"}${prefs.crew ? " · crew" : ""}`}
      </Text>
      {helpOpen ? (
        <SidepanelHelp prefs={prefs} />
      ) : (
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          {rows.length === 0 ? <Text wrap="truncate-end">No visible agents</Text> : null}
          {shown.map((row) => {
            const selectedRow = row.key === rows[selectedIndex]?.key;
            const color = selectedRow ? DASH_CHROME_COLOR.accent : DASH_COLOR[row.state];
            return prefs.compact ? (
              <Text key={row.key} bold={selectedRow} color={color} wrap="truncate-end">
                {`${selectedRow ? "▸" : " "} ${row.icon} ${row.name} · ${row.facts}${row.stream ? ` · ${row.stream}` : ""}`}
              </Text>
            ) : (
              <Box key={row.key} flexDirection="column">
                <Text bold={selectedRow} color={color} wrap="truncate-end">
                  {`${row.icon} ${row.name}`}
                </Text>
                <Text
                  color={selectedRow ? DASH_CHROME_COLOR.accent : undefined}
                  wrap="truncate-end"
                >
                  {row.facts}
                </Text>
                <Text dimColor wrap="truncate-end">
                  {row.stream ?? " "}
                </Text>
                <Text> </Text>
              </Box>
            );
          })}
        </Box>
      )}
      {message ? (
        <Text color="red" wrap="truncate-end">
          {message}
        </Text>
      ) : null}
      <Text dimColor wrap="truncate-end">
        {FOOTER}
      </Text>
    </Box>
  );
}

export async function settleSidepanelRenderer(
  refreshTracker: SidepanelRefreshTracker,
  closeStore: () => void,
): Promise<void> {
  await refreshTracker.settle();
  closeStore();
}

export async function runSidepanelRenderer(): Promise<void> {
  const origin = sidepanelOrigin();
  if (!origin) {
    process.stderr.write("murmur sidepanel renderer must run inside tmux\n");
    process.exitCode = 1;
    return;
  }
  const identity = requireIdentity();
  if (!identity) return;
  const dashStore = openDashStore();
  const refreshTracker = new SidepanelRefreshTracker();
  try {
    const instance = render(
      <App
        dashStore={dashStore}
        initial={status(dashStore.store, identity)}
        origin={origin}
        refreshTracker={refreshTracker}
      />,
    );
    await instance.waitUntilExit();
  } finally {
    await settleSidepanelRenderer(refreshTracker, () => dashStore.store.close());
  }
}
