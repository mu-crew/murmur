// SDK entry. package.json advertises this as the "." export, so anything a
// consumer needs to drive murmur without shelling out to the CLI belongs here.
// The CLI is a thin layer over exactly these units.
//
// Deliberately NOT here: anything from the forbidden-shapes list (no append, no
// log read, no narrow local read, no partial-row update) and no raw database
// handle under any name. `reconcileLocal`, `buildLocalSnapshot` and the one
// ingest, `ingestInbox`, are reachable only as `Store` methods, which keeps
// src/store.ts the sole owner of SQL. The inbox's file side -- writing an event,
// draining a node's inbox -- is here, because a hook writer is a separate
// process and the drain only delivers what the store decides.
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
  type CollectResult,
  collect,
  MAX_CONCURRENT_PEERS,
} from "./collector.js";
export { glance } from "./glance.js";
export { HARNESSES, type Harness, harnessFromArgv } from "./harnesses.js";
export {
  type HookContext,
  harnessHookEvent,
  type MuHookInput,
  type MuHookTarget,
  muHookEvent,
  parseMuHookInput,
} from "./hook.js";
export { HOOK_ROWS, type HookMapping, type HookPayload, mapHookPayload } from "./hook-rows.js";
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
  type DrainOptions,
  type DrainSummary,
  drainInbox,
  INBOX_PANE_CAP,
  type InboxHost,
  inboxDir,
  inboxKey,
  tmuxInboxHost,
  writeInboxEvent,
} from "./inbox.js";
export {
  INBOX_EVENTS,
  type InboxEvent,
  type InboxEventName,
  LAST_TEXT_MAX_BYTES,
  parseInboxEvent,
  parseRemoteEvent,
  type RemoteEvent,
} from "./inbox-event.js";
export { remoteDir, remoteKeyName, writeRemoteEvent } from "./inbox-file.js";
export {
  ATTACH_PLACEHOLDER,
  defaultJumpCommand,
  PANE_PLACEHOLDER,
  renderJumpCommand,
  tmuxAttachCommand,
} from "./jump-command.js";
export { type Mux, pidAlive, tmux } from "./mux.js";
export { configDir, dbPath, stateDir } from "./paths.js";
export {
  type Placement,
  type ProcessRow,
  paneHarness,
  paneProgram,
  placeEvent,
  readProcessTable,
} from "./process-chain.js";
export { parseSnapshot, SnapshotInvalidError } from "./snapshot.js";
export { type Status, status, statusWithCollect, tmuxStatus } from "./status.js";
export { openStore, type Store, StoreTooNewError } from "./store.js";
export type {
  Activity,
  ActivityUpdate,
  AgentClaim,
  AgentMeta,
  AgentRelease,
  AttentionKind,
  AttentionRequest,
  ClaimResult,
  Driver,
  HarnessState,
  InboxDelivery,
  IngestSummary,
  LiveCheck,
  LocalPane,
  LocalWorld,
  Location,
  PaneIdentity,
  PeerFetch,
  PeerRecord,
  ReconcileSummary,
  Snapshot,
  SnapshotAgent,
  SnapshotAttention,
  SnapshotPane,
  TmuxServer,
} from "./types.js";
export { DEFAULT_DRIVER } from "./types.js";
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
