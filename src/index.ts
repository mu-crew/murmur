// SDK entry. package.json advertises this as the "." export, so anything a
// consumer needs to drive murmur without shelling out to the CLI belongs here.
// The CLI is a thin layer over exactly these units.
//
// Deliberately NOT here: anything from the forbidden-shapes list (no append, no
// log read, no partial-row update) and no raw database handle under any name.
// `syncLocal` is reachable only as a `Store` method, which keeps src/store.ts
// the sole owner of SQL; `readLocal` is the one way to read and record local
// panes, and `readStatus` (through `peekLocal`) the one way to read them on a
// read-only store without writing.
//
// The version comes from src/version.ts, the one module that can find
// package.json from any bundle depth.

export {
  agentLabel,
  agentLocation,
  type JumpResult,
  jumpToAgent,
  shellQuote,
} from "./agents.js";
export { type Channel, hasWarmSocket, ssh } from "./channel.js";
export {
  type Collected,
  type CollectResult,
  collect,
  collectAll,
  MAX_CONCURRENT_PEERS,
} from "./collector.js";
export { glance } from "./glance.js";
export {
  createIdentity,
  loadIdentity,
  type NodeIdentity,
  setDisplayName,
} from "./identity.js";
export {
  asPaneId,
  asSessionId,
  asWindowId,
  type PaneId,
  type SessionId,
  type WindowId,
} from "./ids.js";
export {
  ATTACH_PLACEHOLDER,
  defaultJumpCommand,
  PANE_PLACEHOLDER,
  renderJumpCommand,
  tmuxAttachCommand,
} from "./jump-command.js";
export {
  buildSnapshot,
  type LocalPeekRead,
  type LocalRead,
  PANE_FIELDS,
  parsePaneRow,
  peekLocal,
  programState,
  readLocal,
} from "./local.js";
export { type Mux, pidAlive, tmux } from "./mux.js";
export { configDir, dbPath, stateDir } from "./paths.js";
export { readRex } from "./rex.js";
export { parseSnapshot, SnapshotInvalidError } from "./snapshot.js";
export {
  localStatus,
  type ReadStatus,
  readStatus,
  type Status,
  type StatusJson,
  type StatusJsonPane,
  status,
  statusJson,
  statusWithCollect,
  tmuxStatus,
} from "./status.js";
export {
  promptAgent,
  type ResolveResult,
  resolveAgent,
  type SteerDeps,
  type SteerResult,
  stopAgent,
} from "./steer.js";
export { type LocalPeek, openStore, type Store, StoreTooNewError } from "./store.js";
export type {
  Activity,
  AttentionKind,
  BlockedKind,
  Driver,
  LocalPane,
  Location,
  PaneIdentity,
  PaneState,
  PeerFetch,
  PeerRecord,
  Snapshot,
  SnapshotAgent,
  SnapshotAttention,
  SnapshotPane,
  TmuxServer,
} from "./types.js";
export { DEFAULT_DRIVER, DELEGATES_RECORD, ROLE_RECORD, SNAPSHOT_VERSION } from "./types.js";
export { MURMUR_VERSION as VERSION } from "./version.js";
export {
  age,
  type Freshness,
  freshness,
  NEEDS_HUMAN,
  type PaneView,
  paneViews,
  pendingSummary,
  RENDER_PRIORITY,
  type RenderState,
  renderState,
  STALENESS_MS,
  viewSort,
} from "./view.js";
