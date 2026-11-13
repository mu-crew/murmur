# murmur architecture

How it works, why it is built this way, and why it exists rather than a
configuration of something else.

## The problem

Coding agents run on more than one machine: a laptop, a desktop, a remote box.
Each machine knows what its own agents are doing. No machine knows what the
others are doing. So "is anything blocked on me right now" means visiting each
one in turn, and jumping to an agent means first remembering which host it lives
on.

That is the whole problem. Everything below is in service of it, and the design
spends most of its effort refusing to solve harder problems nearby.

## Contract

From 1.0.0, the following interfaces are stable. A breaking change to one of
them requires a major version:

- tmux pane options `@murmur_pane_state` (`crashed`, `error`, `blocked`, `done`,
  `working`, `waiting`, or `idle`), `@murmur_pane_since` (milliseconds since the epoch),
  and `@murmur_pane_label`
- tmux window, session, and server options `@murmur_window_state`,
  `@murmur_window_has_agent`, `@murmur_session_state`, and
  `@murmur_count_<state>`
- `murmur status --json` fields `panes[].pane`, `panes[].local`,
  `panes[].agent_name`, `panes[].workstream`, `panes[].driver`,
  `panes[].activity`, `panes[].attention`, `panes[].freshness`, and
  `panes[].updated_at`
- environment variables read from agent panes: `MU_MANAGED_AGENT`,
  `MU_AGENT_NAME`, `MU_WORKSTREAM`, and `MU_ROLE`
- the `on-attention` hook: its path in the config dir and the `MURMUR_KIND`,
  `MURMUR_AGENT`, `MURMUR_HOST`, `MURMUR_LOCAL`, `MURMUR_PANE` and
  `MURMUR_MESSAGE` variables it runs with

Everything else, including the store schema and other JSON fields, is internal.

## The shape

```
pi agent ──in-process──────────────┐
                                    murmur store ── state.db   (one per node)
hook harness ── murmur hook ── inbox ─┘   ▲ drained by every reader
                                            │
                                    ssh murmur export
                                            │
                                collector ── view ── status / pick / dash / sidepanel
                                                       │
                                     jump: local switch, or ssh -t
```

pi integrates in-process. Every other blessed harness (claude, codex,
cursor-agent, muse) writes events into a per-pane inbox from its hooks,
and readers own the store: `status`, `pane`, the dash and `export` drain the
inbox into it before they read. See [The inbox](#the-inbox).

Each node keeps one SQLite database describing the current state of its own
panes. `murmur export` prints that state as a single complete JSON document — a
**snapshot**. Any node pulls its peers' snapshots over ssh, caches one per peer,
and renders the union as an attention-sorted list. No daemon, no listening
socket, no master node.

Four paint surfaces share that list: `status` (counts), `pick` (fzf jump),
`dash` (cards + pane glance), and `sidepanel` (a compact list in the current
tmux window). Jump is the same whether you left from pick, dash, or sidepanel.
Dash can also send a buffered prompt to the selected pane without leaving the
dashboard.

The side panel uses the existing collector and view pipeline, including the
dashboard's sort and visibility preferences. Only `sidepanel-controller`
changes the tmux layout. It creates a marked pane on the left, then
proportionally reflows the existing layout so the panel spans the full window
height. On close, it removes the marked pane from tmux's current live layout
instead of restoring a saved layout that may no longer match the window.

murmur observes and connects. It does not place work. That is an orchestrator's
job, and mixing the two is how you end up owning scheduling, credentials and
artifact movement.

## The model in one page

Three facts, independent, each with exactly one writer:

| Fact | Meaning | Stored as | Written by |
| --- | --- | --- | --- |
| **activity** | is a process working in this pane | `agents.activity` = `running` \| `stopped` | the pane's owning process only |
| **attention** | does someone need to look at this pane address | rows in `attention`, kind `done` \| `blocked` \| `error` \| `crashed` | owner (`done`/`error`), external notifier (`done`/`blocked`/`error`, per event type), local reconciliation (`crashed`) |
| **freshness** | how recently we reached the node that reported | `peers.fetched_at` | the collector |

They are never folded into one enum, and no stored value spans two of them.
There is no `cleared`: absence of an attention row *is* "nothing to see", and
absence of an agent row *is* "no agent here". The words a surface paints
(`crashed`, `error`, `blocked`, `done`, `running`, `waiting`, `idle`) are derived at read
time by `renderState` and stored nowhere. `waiting` is a stopped agent whose
runtime field `pending` (outstanding background work, such as mu delegates) is
above zero.

Why three and not one. A crashed agent on an unreachable host is crashed *and*
stale, on different axes; a running agent that a notifier flagged as blocked is
both, and the picker shows both. Every attempt to collapse these produced a
question with no answer, and one of them shipped: a focus hook that could
overwrite an agent's state replaced `working` with `blocked` on live panes and
nulled the owner metadata while all three processes were running. The fix is
structural — `attention` has no column an agent field could live in. Its
`driver` column is not one: it says who should hear about that request, as its
requester read its own environment, and it never reaches the `agents` row or
overrides that row's driver.

Identity and address are separated:

- **node identity** — `identity.json`, `{host_id, display_name}`. Created only
  by `murmur init`, and only by it. Survives a store wipe. A 1.x node's identity
  is copied, never minted, on the first run of 2.x (see
  [State directory](#state-directory)).
- **agent identity** — a random UUID minted per *process instance* when it
  claims a pane. It is not derived from the pane, so a new process in the same
  pane is a different agent, and a late write from a replaced owner matches no
  row.
- **pane address** — the tmux server tag plus pane id. The pair is `UNIQUE` in
  `agents` and part of the primary key in `attention`. Pane ids are scoped to a
  tmux server, so `%34` on the default server and `%34` on `tmux -L mule` are
  different addresses.

Truth about a node lives only on that node. Other nodes hold one opaque,
validated snapshot per peer, replaced whole or not at all.

## Why this is not a distributed system

It is single-writer-per-partition caching. Each node owns the state of its own
panes and publishes it; no other node writes about them, ever. Merging is a
concatenation of one local read and one cached document per peer.

Calling it "distributed" invites machinery the problem does not have: consensus,
conflict resolution, vector clocks, leader election. If a change starts to need
conflict resolution, that is the signal the single-writer invariant has been
broken somewhere.

Three consequences worth stating, because each is easy to violate by accident:

- **A node may not write state about another node's panes.** Not even
  corrections. A reader that learns something — a jump proving a pane is gone —
  *reports* it and writes nothing. The next collect reconciles, because the
  owning node is the one that reconciles.
- **Only a pane's own process may report for that pane.** `claimAgent` answers
  `refused` to a second live claimant, and a refused caller registers no
  handlers, writes nothing and publishes no tmux state. This replaced an environment
  marker and three helper functions: a nested pi inherits `$TMUX_PANE` and used
  to report *as* the pane's real agent, so one pane accumulated six reporting
  pids of which one was alive, and the live agent read idle while it worked.
  Silence is correct for a process with nothing true to say.

  For an inbox event the gate applies a pid the HOOK recorded -- the harness
  process its process chain found -- rather than the pid of the process
  writing to the store, which is a reader draining the inbox. The trust model
  is stated, not hidden: any process running as the user can write an event
  file, so inbox state is advisory. Nothing that acts on it (mu) closes work on
  a state transition alone.
- **A node's inbox names only its own panes.** A hook places its event by
  walking its own process chain to a tmux server on this machine, and the
  drain maps that server and pane root to this node's store key the way the
  collector does. A remote worker's hook writes to a separate area keyed by its
  origin, which this node's drain never reads and its snapshot never exports.
- **`murmur notify` is the one deliberate exception, and it is narrow by
  construction.** Its whole request type is `{kind, location, message, source,
  driver}` — there is no `agent_id`, no pid, no activity and no owner metadata,
  so it cannot say anything about a process being alive even by accident.
  `driver` comes from the hook's own environment (`driverFromEnv`), which it
  inherits from the harness, and says only who should hear about the request. Its range is
  `done`, `blocked` and `error`, the kinds a human can answer, chosen from the
  event type the harness itself reports; `crashed` and both activities remain
  reconciliation's and the owner's.

  It was hard-coded to `blocked`, and that was wrong on every call for the
  harness it exists to serve. codex's notify hook fires exactly one event,
  `agent-turn-complete` — the turn ended and the agent is waiting for you — so a
  finished codex turn was recorded as *blocked* while pi's extension recorded
  the same fact as `done`. One harness's completed work was indistinguishable
  from another's request for help, on every turn. An unrecognised event still
  becomes `blocked`, which is the direction that cannot lose information: it
  puts a row in front of a human, and focusing the pane takes it back.

## A tmux server and pane id are the agent's address

Everything below assumes agents run inside tmux. The tagged tmux server and pane
id together are how murmur names an agent and how a jump reaches one.

An agent IS a pane address. A session and a window are only where that pane
currently lives: a pane keeps its id across `move-pane`, `break-pane`, and a window closed
and reopened, while a recorded window id goes stale as a matter of course. So
**only a pane may decide whether an agent exists** — a window id is location,
never evidence of life. tmux says the same thing with its sigils, `$25` / `@75`
/ `%89`, and the three ids are branded types (`SessionId`, `WindowId`, `PaneId`)
so that passing one where another is meant does not compile.

The extension resolves its pane from `$TMUX_PANE` and returns early without one,
so a pi started in a plain terminal records nothing and never appears in the
picker. That is the honest outcome rather than a gap: with no pane there is no
address, and a row you cannot jump to is worse than no row.

Two nearby calls look contradictory and are not:

- `currentWindow()` answers "which pane am I in", so only `$TMUX_PANE` can tell
  it. Asking tmux instead reports whichever pane the server considers active,
  which would let a non-tmux pi record itself in an unrelated agent's pane.
- `livePanes()` answers "which panes exist on this host", which is server-wide
  and correct from anywhere. `export` runs over ssh with no pane of its own and
  still has to see the panes.

`livePanes()` returns `null` for "could not tell", which is deliberately
distinct from an empty set, and `reconcileLocal` treats `null` as no evidence
and writes nothing. Conflating them deletes every agent on the host the moment
tmux is unreachable. A server that is simply not running (`no server running`,
or a missing socket) is a definite answer, and returns the empty set: reading it
as null left a host whose tmux had died exporting its last panes indefinitely.

The rule binds the JUMP as well as reconciliation, and that took two goes to
learn. A local jump asks `livePanes()`, and the remote probe is `tmux list-panes
-a -F '#{pane_id}'` — not `list-windows`, because no answer about windows can
say whether a pane exists. Asking about windows there condemned healthy agents
on one keypress. **A failed jump now mutates nothing**: it returns a
`JumpResult` with a reason and a message, and `pane_gone` is a report rather
than a deletion. That is the same single-writer rule one level down — the jump
runs on the reader, and only the owning node may retire a pane.

The remote jump inherits the tmux requirement, since it is `ssh -t <host> tmux
attach`. tmux must be running on the far side, which is why a dead remote tmux
server gets its own diagnosis rather than being reported as an unreachable host.

The brands (`src/ids.ts`) are phantom types on `string`, so they cost nothing at
runtime and are applied at the edges: `asPaneId` and friends are called where a
bare string arrives — argv, a tmux query, the wire — and everything inside deals
in branded values. What that prevented was the mix-up that deleted ten live
agents: comparing a `WindowId` against a set of pane ids is a compile error.

What it does NOT buy, since that bounds how far the types can be trusted: both
jump paths once compared a `WindowId` against a `Set<WindowId>`, which is
internally coherent and compiles cleanly. Branding stops you MIXING the three
ids; it cannot stop you asking the wrong one a question. A type system polices
which noun you passed, never whether the question was worth asking. Only a test
that moves a pane out from under a recorded window catches that.

Tmux state also has to be cleared from outside, which is why `murmur clear --pane
<id>` exists and why tmux hooks call it. Murmur publishes these tmux options:

- `@murmur_session_state`: the strongest non-idle state among a session's
  panes, for session pickers and `choose-tree`
- `@murmur_window_state`: the strongest non-idle state among a window's panes,
  for status bars
- `@murmur_window_has_agent`: whether the window contains an agent, including when every agent is idle
- `@murmur_pane_state`: one pane's full state, for pane-border formats
- `@murmur_pane_since`: the time in milliseconds since the epoch when the pane
  entered its current state. It changes only with the state and is unset with it.
- `@murmur_pane_label`: one pane's agent name, falling back to its pi session and CLI
- `@murmur_count_<state>` (global): this host's agent counts for a status pill,
  one option per state (`crashed`, `blocked`, `done`, `working`, `waiting`, `idle`) plus
  `@murmur_count_crew`. Unset at zero so a format can test presence. Same fold
  as `murmur status` (`statusRollup`), but local only: remote peers still need
  `murmur status`.

The names are distinct because tmux pane options inherit same-named window
options, and window options inherit session options. A shell beside an agent
must not inherit that agent's state. Every writer recomputes the options from
stored activity and attention, rather than painting the event it just handled.
The session state is computed from the store over the session's panes, not by
folding other windows' published options, which could be stale.

The counts are options rather than one status string because a tmux format can
branch on an option but cannot parse a string. They let a status pill render
with no `#(...)` process per redraw, which on a Node CLI was measured at most of
a core.

## The units

| Unit | Does | Depends on |
| ---- | ---- | ---------- |
| `identity` | Read/create this node's `{host_id, display_name}` | state dir |
| `store` | Claim, report, reconcile, cache. **The only module touching SQL** | `identity` (as a parameter) |
| `snapshot` | **Pure.** `parseSnapshot`: validate one document, totally | nothing |
| `view` | **Pure.** `SnapshotPane[]` in, `PaneView[]` out | `store` (types) |
| `channel` | Seam: `exec(target, argv) -> stdout`. One impl: ssh | OS |
| `collector` | Fetch each peer, validate, replace its cache whole | `channel`, `store` |
| `mux` | Seam: window/pane queries, tmux state options, attach. One impl: tmux | OS |
| `process-chain` | **Pure** over a `ps` table: place a hook's event by walking to its tmux server | OS (`ps`) |
| `inbox` | Write one event file; drain every pane inbox into the store and publish pane options | `store`, `mux`, `process-chain`, `socket-cache` |
| `socket-cache` | Remember each tmux server's socket across processes, keyed by pid and start time | state dir, `process-chain` |
| `legacy-state` | Copy a 1.x node's identity, and a private copy of its store for the peers, on the first run | the 1.x state dir, read only |

`view` and `snapshot` being pure and `store` being the only SQL is the boundary
that carries the design. All three are testable without a machine, a network or
a multiplexer.

**One local read.** `Store.localPanes()` is the only way to read local state,
and it returns `SnapshotPane[]` — the same shape a peer's cached snapshot holds.
So `paneViews` maps one type to `PaneView` exactly once, and a local pane and a
remote pane travel the same code path, differing only in the `host_id`, `local`
and freshness fields the caller supplies. There is no `agentForPane`, no
`attentionFor`, no `agents()`: it was the proliferation of narrow reads that let
`clear` and the extension each derive their own idea of what a pane's state was,
across fourteen sites and six shipped bugs.

`owner_pid` is not in that shape. It is local-only, never in a snapshot and
never on the wire, which makes remote liveness inference *unrepresentable*
rather than discouraged. A remote pid names a process in another machine's table.

The `Store` interface is closed, and adding a method is a contract change. Some
shapes are forbidden outright, each because it once let a writer say something
it had no standing to say: anything that takes a row and writes it (`append`,
`ingest`, `put`), any log read, any partial-row or column-map update, any
activity write keyed on pane alone rather than on `agent_id` plus `owner_pid`,
any attention method that accepts an agent field (an attention row's own
`driver` is the request's audience, not the agent's), and any escape hatch exposing
the database handle.

Two seams exist with exactly one implementation each: `channel` (ssh) and `mux`
(tmux). Defined so a second backend is possible; not designed for one that does
not exist. The harness is not a third: pi reports in-process through the
extension, the blessed hook harnesses write inbox events through `murmur hook`,
and any other harness comes in through `murmur notify`. Both are commands
rather than interfaces to implement.

**The one ingest.** "No `ingest`" reopens for exactly one path, the inbox
(`Store.ingestInbox`). It is an ingest keyed on pane, not an event log: the
caller delivers events, the store decides what each means under its ownership
rules, and an applied event is deleted. There is no replay, no retention and no
history. Its read side, `harnessState`, is local-only like `owner_pid`: none of
it reaches a snapshot.

## State directory

Everything murmur keeps lives in `$XDG_STATE_HOME/murmur2` (by default
`~/.local/state/murmur2`): `state.db`, `identity.json`, the compile cache and
the tmux socket cache. The inbox and the remote area are the exception, fixed
at `~/.local/state/murmur2/{inbox,remote}` whatever `XDG_STATE_HOME` says (see
[The inbox](#the-inbox)). `MURMUR_STATE_DIR` moves all of it.

The directory is versioned by breaking change, not by release. 1.x used
`murmur`, and its schema-9 store refuses any store from schema 10 up, so the
hook-harness store (schema 11) could not share it without breaking a 1.x
install still running beside it (an older pi extension, say). An additive
change stays in the current directory; the next breaking one moves to
`murmur3`.

The first run of 2.x migrates from the 1.x directory (`$XDG_STATE_HOME/murmur`,
else `~/.local/state/murmur`), never under `MURMUR_STATE_DIR`
(`src/legacy-state.ts`). The first identity read that finds none, or the first
open that creates `state.db`, copies `identity.json`, so the host keeps its
`host_id`; that open also takes the old store's peer names, targets and jump
commands, from a private copy of the file and its `-wal` and only when its
schema is one this build reads. Nothing in the old directory is written, moved
or deleted, not even a `-shm`, so 1.x keeps working there; agents and attention
are not carried, and reappear on their next event.

## The data model

Five tables in `state.db`, all `STRICT`, `user_version = 11`. `agents` and
`attention` are local truth; `peers` is a cache of other nodes; `compat` holds
the one-row "compatible since" stamp (see Versioning below); `alerted`
remembers which attention events the `on-attention` hook has run for (see
[Alerting](#alerting)).

```sql
CREATE TABLE agents (
  agent_id     TEXT    NOT NULL PRIMARY KEY,   -- a UUID per process instance
  server_kind  TEXT    NOT NULL CHECK (server_kind IN ('default', 'label', 'path')),
  server_value TEXT    NOT NULL,
  pane         TEXT    NOT NULL,               -- id within the tmux server
  owner_pid    INTEGER NOT NULL CHECK (owner_pid > 0),
  activity     TEXT    NOT NULL CHECK (activity IN ('running', 'stopped')),
  session      TEXT    NOT NULL,               -- location, may change
  window       TEXT    NOT NULL,
  session_name TEXT, window_name TEXT,
  agent_name   TEXT, pi_session TEXT, workstream TEXT, role TEXT,
  cli          TEXT    NOT NULL,
  driver       TEXT    NOT NULL CHECK (driver IN ('human', 'orchestrated')),
  -- runtime columns (model, effort, usage, pending, ...) elided
  source       TEXT    NOT NULL DEFAULT 'pi' CHECK (source IN ('pi', 'inbox')),
  harness      TEXT,                           -- claude, codex, cursor-agent, muse, pi
  session_id   TEXT,                           -- the hook harness's session
  run_count    INTEGER,                        -- prompts this session; null for pi
  last_text    TEXT,                           -- last turn's text, at most 64 KB
  last_text_run  INTEGER,                      -- run_count of the turn that wrote last_text
  confirmed    INTEGER NOT NULL DEFAULT 1,     -- 0: activity is mu's word (`idle?`)
  generation_id  TEXT,                         -- last ended turn's generation (cursor-agent, muse)
  generation_end TEXT,                         -- how it ended: stopped, interrupted, failed
  generation_run INTEGER,                      -- run_count that generation ended in
  claimed_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (server_kind, server_value, pane)
) STRICT;

CREATE TABLE attention (
  server_kind  TEXT    NOT NULL CHECK (server_kind IN ('default', 'label', 'path')),
  server_value TEXT    NOT NULL,
  pane         TEXT    NOT NULL,
  kind         TEXT    NOT NULL CHECK (kind IN ('done', 'blocked', 'error', 'crashed')),
  message      TEXT    NOT NULL,
  source       TEXT    NOT NULL,
  driver       TEXT    NOT NULL CHECK (driver IN ('human', 'orchestrated')),
  session      TEXT    NOT NULL,               -- its own location: see below
  window       TEXT    NOT NULL,
  session_name TEXT, window_name TEXT,
  requested_at INTEGER NOT NULL,
  PRIMARY KEY (server_kind, server_value, pane, kind)
) STRICT;

CREATE TABLE peers (
  name TEXT NOT NULL PRIMARY KEY, target TEXT NOT NULL,
  host_id TEXT, display_name TEXT,
  snapshot TEXT, snapshot_at INTEGER,          -- the whole document, their clock
  fetched_at INTEGER, last_attempt_at INTEGER, last_error TEXT,
  murmur_version TEXT, snapshot_version INTEGER
) STRICT;
```

Schema facts that are load-bearing, and the reason each is in the schema rather
than in a comment:

1. **The server/pane address is `UNIQUE`.** "One top-level instrumented agent
   per pane address" is enforced by SQLite, while the same pane id may exist on
   another tmux server.
2. **`agents.agent_id` is a UUID, not `host:pane`.** A replacement owner is a
   different row, so a late write from the previous owner matches nothing and is
   silently ineffective rather than destructive.
3. **`owner_pid` is local-only**, per the previous section.
4. **`attention` has no `agent_id` and no `owner_pid` column.** An attention
   writer structurally cannot address an agent's identity, activity or metadata.
   This is the whole fix for the live-corruption incident described above.
5. **`PRIMARY KEY (server_kind, server_value, pane, kind)`.** Kinds coexist: a
   `crashed` row is not clobbered by a later `blocked`, and focus clears all
   attention for one address with its full server/pane key.
6. **`attention` carries its own location.** An attention-only pane — a codex
   agent murmur never instrumented — is listable and jumpable with no agent row.
   `attention.pane` deliberately does not reference `agents.pane`; a constraint
   saying otherwise would make that case unrepresentable.
7. **`peers.snapshot` is one TEXT column** holding the validated document.
   Whole-peer atomic replacement is therefore structural: there is no partial
   apply to get wrong.
8. **`CHECK` constraints on `activity`, `driver`, `kind`.** An unknown value
   cannot reach storage, so no sort, count or render path needs a fallback
   branch. An unknown state that sorted as `NaN` was a real bug.

No index beyond the declared keys: both local tables are bounded by the number
of live panes on one machine.

**Who writes each fact**, since "it is in the enum" is not the same as
"something produces it" — `blocked` sat in an enum unproduced for months while
three surfaces carried machinery for it:

| Fact | Written by | On |
| --- | --- | --- |
| `activity = running` | pi extension | `agent_start` |
| `activity = stopped` | pi extension | `agent_end` |
| attention `done` | pi extension | `agent_settled`, pane unfocused, `driver = human`, no pending work |
| attention `error` | pi extension | `agent_settled`, pane unfocused, last assistant message `stopReason: "error"`; any driver, any pending count |
| runtime `pending` | pi extension | a `murmur:pending` report on pi's event bus |
| attention `done` | `murmur notify` | a harness event meaning "turn over, waiting" (`agent-turn-complete`, `session.idle`); any driver, recorded on the row |
| attention `error` | `murmur notify` | a Cursor stop with `status: error` |
| attention `blocked` | `murmur notify` | any other outside-in call, including an event murmur does not recognise |
| attention `crashed` | `reconcileLocal` | pane alive, owner pid gone, activity was `running` |
| (row removed) | `releaseAgent` | `session_shutdown` |
| (attention removed) | `acknowledgePane` | `murmur clear`, i.e. tmux focus, `i` in the dash (over ssh for a remote pane), or mu's `murmur clear -L/-S` before a retry |
| activity, `run_count`, `last_text`, attention `done`/`blocked`/`error` | the inbox drain | a hook harness's events; see [The inbox](#the-inbox) |

Nothing writes `crashed` from inside an agent, for the obvious reason.

**Pending work holds `done` back.** Other extensions in the same pi report
outstanding background work on pi's in-process bus as
`pi.events.emit("murmur:pending", { source, count })`; mu's `mu_delegate` is
the first producer. The extension sums the counts by source, writes the total
as the agent's `pending`, and raises no `done` on a settle while it is above
zero. A parent that fans out delegates ends its turn to wait for them, so that
settle is not completion. Each answer arrives as a follow-up that runs the
agent again, and the producer reports zero before it delivers the last one, so
the settle after that run raises the real `done`. The channel name is a
string on both sides, so neither package imports the other.

**Versioning is one strategy, not two.** On open, if `user_version` is older
than this build's, murmur salvages `SELECT name, target FROM peers` — the two
fields a human typed — deletes the database and its `-wal`/`-shm` sidecars,
recreates the schema, and re-inserts those peers with every observed column
`NULL`. There is no `ALTER TABLE` in this build. Any change to any table bumps
the version, which is affordable precisely because nothing here is history:
everything in the file is either current state or a cache.

The rebuild only runs upward. A `user_version` above this build's is refused
(`StoreTooNewError`, exit 4 from the CLI; the extension goes silent) and the
file is left alone -- unless its `compat` stamp says this build can still use it.
The pi extension and the CLI are separate installs that can run different
versions, and rebuilding downward made the two wipe each other's rows on every
open.

**The "compatible since" stamp.** Schema 10 writes `compat.compatible_since =
10` beside `user_version`. A later build that only adds nullable columns bumps
`user_version` and keeps the stamp, so this build opens its store rather than
refusing it: every INSERT here names its columns, and a column it does not know
takes its default. Schema 10 is the one reset the stamp cannot spare, because
older builds have no stamp; the CLI and the pi package upgrade together for it.
Schema 11 is the first to use the stamp: it adds the nullable `last_text_run`
and `generation_run` and keeps `compatible_since = 10`, so a schema-10 build
opens a schema-11 store and leaves the new columns alone. Such a build does not
keep `last_text_run` in step with `last_text`, which is the cost the stamp
accepts for an additive column.

**Identity is never minted by the store.** `openStore()` takes no arguments and
creates no identity; the one file it touches is a 1.x node's `identity.json`,
copied when it creates the store for the first time (migration, not minting; see
[State directory](#state-directory)). `createIdentity` is called only by `murmur
init`; `setDisplayName` backs `murmur init --name` on an existing node and keeps
its `host_id`. Every command that needs a `host_id` — `export`, `collect`,
`status`, `pick`, `doctor` — calls `loadIdentity()` and fails with `murmur is
not initialised on this node; run: murmur init`. A node that came into existence
as a side effect of a status-bar tick has an identity nobody chose. `peer` reads
identity opportunistically instead: `peer add` uses it only to refuse adding
this node to itself, so an uninitialised node can still configure peers and that
refusal is best effort.

`notify` and `clear` are absent from that list as a consequence of the model
rather than as an exemption: both address a pane, and `attention` is keyed on
pane alone, so neither reads `identity.json` and neither can fail for want of an
identity.

**Transactions.** `claimAgent` and `reconcileLocal` are `IMMEDIATE`: both read
then write, and a deferred transaction would start as a reader and fail
`SQLITE_BUSY_SNAPSHOT` on upgrade — measured at 5 of 8 concurrent writers
failing. Everything else is a single statement, atomic by construction.
`localPanes` is a deferred read transaction, so a pane cannot appear with an
agent and without the attention that was there when the agent was read.
`buildLocalSnapshot` is two transactions rather than one, because a write
transaction held open across the read would serialise every focus hook on the
machine behind an export.

Deliberately absent from the model: a generic `put`/`del` op-log (that needs
conflict resolution, which single-writer partitioning lets us skip, and it would
simply *be* `mu`), task/DAG structure (observing a task graph means owning it),
and any hybrid logical clock (nothing depends on cross-node causality; clock
skew affects display order only).

**TypeScript, on install-story grounds.** pi is an npm package, so every node
running agents already has Node and npm. Python would mean inventing a
cross-machine install story for the ecosystem that handles it worst, on machines
where the system interpreter is least yours to touch.

## The inbox

How claude, codex, cursor-agent and muse report state, given that none of
them can load an extension into their own process. The event format, the
placement rules and the drain live in `src/inbox-event.ts`,
`src/process-chain.ts` and `src/inbox.ts`; each harness's hook row maps its own
payload onto the vocabulary below.

```text
harness hook ─► murmur hook <harness> ─► one event file in the pane's inbox
murmur status / pane / dash / export ─► drain the inbox into the store under its lock ─► state + pane options
```

**One event, one file.** A hook maps one payload to a canonical event, writes it
under `inbox/tmp/` and links it to `inbox/<pane key>/<ns timestamp>-<pid>.json`,
in `~/.local/state/murmur2/inbox` whatever `XDG_STATE_HOME` says: Muse's hooks
keep `HOME` and lose `XDG_STATE_HOME`, so writers and readers agree on the home
path (`homeStateDir`; `MURMUR_STATE_DIR` still moves it). The remote area sits
beside it for the same reason.
A reader never sees a partial event, whatever its size. The hook opens no
database, takes no lock, calls no tmux and prints nothing, and stops writing for
a pane past 10,000 waiting files (`doctor` reports it).

**The process chain places an event, not the environment.** A harness may clear
its hooks' environment, so a hook reads the process table once and walks its
parents to the tmux server (field 2 of `$TMUX` when set, else the tmux argv).
The pane root is the ancestor right below the server, and the pane key is a hash
of the server pid and the root pid. The event also records the server's socket
as the server's argv names it (`server_socket`: `-S <path>`, `-L <name>`, the
default, or procps's `tmux: server (<path>)` title on Linux), because a hook
with no `$TMUX` otherwise leaves the drain only a pid to find the server by.
Harnesses are matched by argv (`src/harnesses.ts`), and an adjacent run of one
harness -- a launcher and the binary it starts -- is one harness. A second,
separate harness before the server means a nested agent, and nothing is written;
so does a chain that never reaches a tmux server. A one-shot run (`codex exec`,
`muse exec`, `claude -p`/`--print`, `cursor-agent -p`/`--print`, read from the
harness's own arguments by `runMode`; `codex e` and `codex review` count too)
with an interactive member of the same harness above it is a nested agent too,
though no shell separates them: the run splits where it turns one-shot. A member
whose arguments cannot tell -- a launcher option murmur does not know, before a
bare argument that may be its value -- never splits a run. A one-shot run on its
own in a pane is that pane's harness. An anchor file mu wrote for an ancestor
supplies the agent's identity. Anchors are read from
`~/.local/state/mu-next/anchors/<pid>.json` first, whatever the environment
says, then from `$XDG_STATE_HOME/mu-next/anchors` when that is another
directory: Muse's hooks keep `HOME` and lose `XDG_STATE_HOME`, so the home path
is the one place every hook can find. An anchor counts only when its
`start_time` matches the process's; a stale file at home does not hide a live
one in the fallback.

**Readers drain.** Under the store's write lock (`ingestInbox`, `IMMEDIATE`), a
reader lists each pane's inbox in name order, applies each event and deletes the
file. Before that, outside the lock, it maps each inbox's server pid to a tmux
server and its root pid to a pane (`list-panes -F '#{pane_pid} #{pane_id}'`),
and deletes the inbox of a dead server or a gone pane. A server pid is located
cheapest first: the socket cache (`tmux-sockets.json` in the state directory,
which outlives the process and counts an entry only while the pid's start time
matches), then the event's `$TMUX`, then its `server_socket`, then the reader's
own server (`$TMUX`), each checked by asking that socket for its pid, and only
then by asking each socket in tmux's directory, skipping the ones the cache
says belong to another live server or had no server in the last ten minutes.
A socket that accepts and never answers holds its tmux client until it is
killed, so the hints are asked together, then the directory's sockets together,
and all the asking in one drain shares a 1.5 s budget, of which a lookup's hints
get at most half of what is left, so a wedged hinted server cannot starve the
scan. What has not answered by then is killed and is not an answer: it is not
cached (a live server under load is slow, not silent) and the next drain asks it
again. An inbox whose server pid is alive but answers on no socket the drain
can find, or not within the budget, waits for a later drain, until its oldest
event is an hour old. A drained inbox's emptied directory is
removed (non-recursively, so a hook that just linked an event keeps it; a hook
that finds it gone recreates it): the key is a one-way hash, so an empty
directory could never be checked against its server or pane again. After the
apply, the drain publishes `@murmur_pane_state` and the other pane options for
every pane it changed, through the same `publishAgentStates` every writer uses.

**Ownership, in order:**

1. A row with source `pi` ignores inbox events while its pi lives.
2. A pane with no row, or a dead owner (a dead pi's included, as pi's own claim
   replaces one), is claimed on the first event of any kind, so a hook installed
   mid-session recovers -- except `session_end`, and never while a pi runs in
   the pane's process tree. A pi below the event's own harness does not count:
   that pi is the harness's nested agent, not the pane's owner.
3. A different live owner is refused: the store's nested-agent defence, with the
   pid the hook recorded.
4. An event whose `session_id` differs from the claimed session is ignored,
   unless it is `session_start`.

**pi keeps its pane.** pi's claim replaces an `inbox` incumbent unless that
incumbent's owner is alive AND is pi's ancestor. That covers a stray inbox claim
during pi's `/new` release window or after a store reset, while a pi nested
under a live claude is still refused. So is a pi whose process chain shows a
live claude, codex, cursor-agent or muse between it and the tmux server, even
with no row for that harness yet: until a reader drains, the harness's events
wait in the inbox and the pane looks unclaimed. That check reads the process
table only for a claim the pi makes about itself under `$TMUX`, and reads as
"not nested" when it cannot tell, so a pi that is not nested claims as before.
That replace KEEPS the incumbent's attention rows; only a dead `pi`
incumbent's are cleared, as before.

**The vocabulary.**

| Event | Effect |
| --- | --- |
| `session_start` (source) | claim if unclaimed; `startup`/`clear`: new `session_id`, `run_count` 0, idle; `resume`: idle; `compact`: nothing |
| `prompt_submitted` | running; `run_count += 1`; clear `done` and `error` |
| `continued` | running (mu's stop hook blocked the stop) |
| `permission_requested` | attention `blocked`, message is the tool |
| `interrupted` | from the harness: idle; from mu: `idle?` until the next harness event |
| `turn_stopped` | idle; `last_text` (64 KB) and `last_text_run`; `done` through `settledState` |
| `turn_failed` | idle; attention `error` |
| `session_end` (reason) | `clear`: keep the claim; otherwise release, keeping attention |

`blocked` clears on the next event of any other kind. A new prompt answers the
last turn's outcome, a failure as much as a finish, so it clears `error` as it
clears `done`; without that, a failed turn's `error` outlived every later turn
until someone focused the pane.

`last_text_run` is the `run_count` of the turn that wrote `last_text`. A turn
that ends without text of its own (an interrupt, a failure, an unnamed stop with
no text) leaves both alone, so a reader such as mu's settle can tell this turn's
text from an earlier one's: `last_text_run` below `run_count` means the text is
older than the last turn. A named turn's stop with no text writes a null text at
its own run; its late text then takes the run that turn ended in
(`generation_run`), even when it lands during the next turn. A new session
resets both to null.

The transitions are one pure function (`src/turn.ts`), shared by the drain and
the remote area's fold, so a remote worker's state follows the same rules as a
local pane's.

**Generations.** cursor-agent names each turn with a `generation_id` and
reports a turn's end in up to three events that run concurrently: its text
(`afterAgentResponse`), its `stop`, and, after an abort, an `error` stop for
the same generation. The row keeps the last ended turn's generation and how it
ended. A turn ends once, on whichever of its text or its stop is applied
first; a later `turn_stopped` for the same generation only fills in the text,
and one without text changes nothing. A named turn's stop with no text leaves
`last_text` null rather than the previous turn's, until its text arrives. A
`turn_failed` for a generation that ended `interrupted` is dropped, and an
`interrupted` applied after its own `turn_failed` clears that `error`. Muse
names its turns too (`turn_id`, carried on `UserPromptSubmit`, `Stop` and
`Interrupt`): its `Interrupt` hook is async and can land after its turn's
`Stop`, even during the next turn, so an `interrupted` for a generation that
ended `stopped` or `interrupted` is dropped, and a second `Stop` for one turn
(a Stop hook's block continued it) only refreshes the text. Events without a
generation (every other harness, and mu's) never touch these columns.

**The hook rows.** `murmur hook <harness>` is the command a harness's hook
runs, once per hooked event, with the payload on stdin. Each harness's row
(`src/hook-rows.ts`) maps a payload to one event and owns that harness's drop
rules; the process chain then places it (`src/hook.ts`). The command opens no
store, takes no lock, calls no tmux, prints nothing and exits 0, whatever
happens: claude reads exit 2 from a Stop hook as "block the stop".

| Event | claude | codex | cursor-agent | muse |
| --- | --- | --- | --- | --- |
| `session_start` | `SessionStart` (`source`) | `SessionStart` (`source`) | `sessionStart` | `SessionStart` (`source`) |
| `prompt_submitted` | `UserPromptSubmit` | `UserPromptSubmit` | `beforeSubmitPrompt` | `UserPromptSubmit` |
| `permission_requested` | `PermissionRequest` (`tool_name`); `Notification` of type `permission_prompt` | `PermissionRequest` | none: no permission hook | `PermissionRequest` (`tool_name`) |
| `turn_stopped` | `Stop` (`last_assistant_message`) | `Stop` (`last_assistant_message`) | `afterAgentResponse` (`text`); `stop` with `status: completed` | `Stop` (`last_assistant_message`) |
| `turn_failed` | `StopFailure` (`error`, `error_details`) | none seen | `stop` with `status: error`, unless it echoes an abort | `StopFailure`, in claude's shape (not recorded) |
| `interrupted` | none: mu writes it | `Interrupt` | `stop` with `status: aborted` | `Interrupt`, from Muse-format settings hooks only |
| `session_end` | `SessionEnd` (`reason`) | `SessionEnd` (`reason`) | `sessionEnd` (`reason`) | `SessionEnd` (`reason`) |
| dropped | `SubagentStop`, any other event; chains that never reach tmux | every payload with `transcript_path: null` (the hidden title-generation session) | any other event or status | `SubagentStop` (its reminder subagents), any other event |

Every cursor-agent event carries its `generation_id` (see Generations above).
Its `user_email`, and `CURSOR_USER_EMAIL` and `CURSOR_ASKPASS_SECRET` in its
hooks' environment, never reach an event: a row copies only the fields it maps.
Muse's hooks run with a cleared environment, so a Muse event is placed by its
chain alone and named by mu's anchor; its payloads all carry `transcript_path:
null`, which is why codex's title-session rule is codex's alone.

The last assistant text comes from the payload, capped at 64 KB in the event
file. Nothing reads a transcript: when the hook runs, the transcript can still
end with the previous turn. Prompts, tool inputs and transcript paths never
reach the event.

The agent's identity comes from mu's anchor when an ancestor has one, and is
then crew; otherwise from `MU_AGENT_NAME`, `MU_WORKSTREAM`, `MU_ROLE`,
`MU_AGENT_CLI` and `driverFromEnv`. A hook configured for one harness that
runs under another writes nothing. An agent whose anchor has a remote key
(or, with no anchor in its chain, whose hook sees `MU_REMOTE_KEY`) writes
nothing here: its events go to the remote area below.

`murmur hook mu` is mu's way into the same inbox: one vocabulary event as JSON
on stdin (`{"event": "continued"}`, plus any of `harness`, `session_id`,
`source`, `reason`, `message`, `text` and `agent`), written with `by: "mu"`.
`--by harness` writes it with `by: "harness"` instead, for an event the harness
itself reported on a remote node that mu relays: codex's `Interrupt` or
cursor-agent's aborted stop is then confirmed on the origin pane, as it was on
the node, rather than read as mu's own unconfirmed `idle?`. mu's own events,
its interrupts included, keep the default. `by` decides nothing but that
confirmation.
Without
`--pane` it is placed by the process chain like a harness hook, so `mu hook
stop`, running as the harness's own Stop hook, lands its `continued` on that
pane with that harness's owner pid. With `--pane %N` (and `-L`/`-S`), tmux
names the pane's server and root, and the pane's harness is found from the
root downward (`paneHarness`): the shallowest harness process, then down its
launcher-plus-binary run to the member the pane's own hooks record as owner,
so mu's event passes the same owner gate. A pane with no local harness (an ssh
pane) takes the `harness` mu names, and as owner the shallowest process in the
pane that is not a shell (`paneProgram`: the ssh, not the login shell under
it), so the claim dies with the remote session and a harness started in the
pane afterwards can take it. A pane holding only shells is refused: its shell
would own the pane, and refuse every later harness, for as long as it lives.
The agent's identity is the anchor's when the pane has one, else the `agent`
object mu sends (`agent_name`, `workstream`, `role`, `cli`, and `driver`
`human` or `orchestrated`), so a remote crew worker's relayed turn raises no
`done`; the store fixes a row's identity when it claims the pane. `hook mu` is
the one form that reports failure, on stderr with exit 1 (exit 2 for a bad
`--pane` or an unknown option).

A nested `codex exec` is not always behind a shell: a shell that `exec`s its
only command leaves the nested codex directly below the outer one (U0 recorded
`codex.real < codex exec < codex.real` and `muse.real exec < muse exec <
muse.real`). The one-shot rule above drops its events at the hook, so they
never reach the pane, claimed or not. `paneHarness` stops at the same split,
so `murmur hook mu --pane` names the outer run's member as owner, never the
nested one.

`murmur pane <pane> --json` drains first and prints one pane's state with the
harness-side fields (`run_count`, `session_id`, `last_text`, `last_text_run`),
for mu's send gate and acknowledgement. It drains that pane's inbox and no
other: one `display-message` on the server it reads against (`-L`/`-S`, else
`$TMUX`) gives the server and root pids that name the inbox, so it never looks
for another inbox's server, and a slow one costs a later `status`, not mu's
send gate. `murmur pane --remote` reports `last_text_run` the same way. None of
those fields reach the snapshot: `toAgent` picks its fields explicitly, and a
test pins the document byte for byte.

**The remote area.** A worker mu starts on this node for a pane on another
(D11) carries a remote key, `<origin host>/<origin pane key>`, in its anchor or
`MU_REMOTE_KEY`. Its hooks write to `remote/<key>/` (the key percent-encoded,
dots included, into one file name; `remote/.tmp/` for the writes), whether or
not their chain reaches a tmux server here -- under plain ssh it ends at
`sshd`. Nothing on this node reads that area but `murmur pane --remote <key>`:
the drain, the store and the snapshot never see a remote worker, so the origin
stays the one writer of its pane's row. That read takes the key's lock
(`remote/<key>.lock`), applies the waiting events in name order to the key's
state with the same transitions as the store and the store's ownership rules
for a key (the first harness event claims it, a different live owner is
refused, another session's events are ignored), replaces `remote/<key>.json`
by rename after each, and deletes the files. It prints the state in
`murmur pane`'s words, plus the events it applied this time, which mu relays
to the origin's ssh pane through `murmur hook mu --pane`. A released key keeps
its last turn, so mu can collect a worker's final text after it exits.
`murmur hook mu --remote <key>` writes one of mu's events (an interrupt it
sent) into the area; it names no owner, applies to whoever holds the key, and
cannot claim one. A crew worker's settled turn raises no `done` there: the
origin's drain decides, focus included, when mu relays it.

**pi's store-free mode.** With `MU_PI_CHANNEL=hooks`, mu drives a pi pane
through the `hooks` channel, and murmur's pi extension reports like a hook
harness (`extension/inbox-mode.ts`): one inbox event per pi event, harness
`pi`, placed by the same walk starting at pi's own pid. It is for a pi build
that breaks the store or its native module, so it never imports the store,
never claims, publishes nothing and asks tmux nothing; the drain does the rest.
The pane has one writer, so the drain's "a pi runs here" check does not apply
to `pi` events. The mapping: one `session_start` (`resume`) when the extension
loads, so the pane is claimed at once as the in-process mode claims it, without
resetting the turn that a `/reload` (which loads a fresh extension instance
before its own `session_start`) keeps; `session_start` (`startup`, `clear` after
`/new`,
`resume` after `/reload`), `input` to `prompt_submitted`, `agent_start` to
`continued`, `ui_prompt_start` to `permission_requested`, `agent_settled` to
`turn_stopped` with the last assistant message's text (or `turn_failed` with
its error), and `session_shutdown` to `session_end`, keeping the claim for all
but a quit.

## The snapshot

`murmur export` takes no options and prints one complete document. There is no
`--since`, no watermark, no delta form and no JSONL.

```jsonc
{
  "murmur_snapshot": 6,
  "host_id": "1d2ee96e-3a94-41b2-90fa-5f1ee2f04276",  // from identity.json
  "display_name": "macbook-pro",
  "murmur_version": "0.4.0",         // read from package.json, never restated
  "generated_at": 1788105698997,     // this node's clock at build time
  "panes": [
    {
      "server": { "kind": "default" },
      "pane": "%250",
      "session": "$25",
      "window": "@75",
      "session_name": "hacking/murmur",
      "window_name": "worker-1",
      "agent": {
        "agent_id": "c0ffee00-1111-2222-3333-444444444444",
        "activity": "running",
        "agent_name": "worker-1",
        "pi_session": null,
        "workstream": "murmur",
        "role": null,
        "cli": "pi",
        "driver": "orchestrated",
        // Runtime: what the agent is running WITH, as the agent reports it.
        // Every field nullable -- a harness that knows none of this says so.
        "model": "claude-opus-5",      // leaf only; the vendor is `provider`
        "provider": "anthropic",
        "effort": "medium",            // pi's ThinkingLevel, a closed set
        "provider_effort": "medium",   // what the provider APPLIED, when it says
        "context_pct": 11.7,
        "context_tokens": 93600,
        "context_window": 800000,
        // Tokens and money, nullable as a UNIT: an agent that has completed no
        // turn has no usage, which is not the same as zero.
        "usage": {
          "input": 213000, "output": 55000,
          "cache_read": 4100000, "cache_write": 12000,
          "cache_write_1h": 500,         // Anthropic only; null elsewhere
          "reasoning": 9000,             // subset of output; provider-dependent
          "total_tokens": 4380000,
          "cost_input": 1.2, "cost_output": 2.4,
          "cost_cache_read": 0.41, "cost_cache_write": 0.6,
          "cost_total": 4.61
        },
        "claimed_at": 1788105600000,
        "updated_at": 1788105690000
      },
      "attention": [
        { "kind": "blocked", "message": "needs input", "source": "codex",
          "driver": "human", "requested_at": 1788105680000 }
      ]
    }
  ]
}
```

Rules, each of which a reader depends on:

1. **The document is complete, so absence is absence.** A peer that answers has
   said everything it knows, and a pane present in the previous fetch and
   missing from this one is gone. This is what makes whole replacement correct.
2. `owner_pid` is absent, on purpose. A reader has no pid to probe.
3. A pane with `"agent": null` is an attention-only pane: valid, listable,
   jumpable. A pane with `"agent": null` and `"attention": []` is not emitted.
4. `server` is an exact tagged value: `default` has no `value`, `label` has a
   non-empty value, and `path` has an absolute path. A remote path is interpreted
   only on the node that owns it.
5. `panes` order is presentation-only. Emitted sorted by server and pane id so
   the output diffs cleanly; readers sort for themselves.
6. `generated_at` is the *producing* node's clock. What it is not is when the
   reader fetched it — see freshness below.
7. **Runtime fields are reported, never inferred.** They come from the owning
   agent via its harness extension, on the events that move each one: a model
   change, an effort change, a completed turn. murmur does not derive them, does
   not compute one from another, and above all does not read them out of the
   pane. A dashboard card that needs them draws from collected state, which is
   why it works for a remote agent at all.

   The pane scraper (`piFooter`) survives as a *display* fallback for the one
   selected card, and only there. It produces a string for a human, never values
   for a row, and nothing it produces enters a snapshot. Scraped figures are
   rounded for a terminal (`↑836k`, not `836123`), so writing them would
   manufacture precision murmur never had and no reader could tell a report from
   a guess.
8. **`usage` is nullable as a unit.** It arrives as one bundle per completed
   turn — one clock, one provenance — so a partial write could pair this turn's
   cost with last turn's tokens. An agent that has completed no turn has no
   usage, which is a different claim from zero. An aborted or errored turn
   reports no usage: pi's is partial at best, and all zeroes when pi
   synthesises the failure. Nothing renders these figures yet; they are
   carried so that a later display costs no wire change.

`buildLocalSnapshot` reconciles before it reads, which is what makes the
document authoritative: a snapshot built from unreconciled rows would publish
agents whose panes are gone, and a reader has no way to tell.

**Validation is total and strict**, and happens before storage.
`parseSnapshot` rejects an unknown key, a missing key, a wrong type, a
`murmur_snapshot` other than `6`, a malformed server tag, an unknown `activity`,
`driver`, `kind` or `effort`, a `context_pct` outside 0..100, a negative token
count or cost, a duplicate server/pane address, and a pane that is neither an
agent nor an attention. Nothing is
coerced, defaulted or carried through. The error names the first failing path
(`panes[3].attention[0].kind`), and the collector turns it into a failed fetch:
a peer that answers with a bad document is **reachable but broken** and visibly
so, not silently stale.

**Compatibility is offered in neither direction**, and that is the honest report
rather than a shortcut. A higher `murmur_snapshot` is rejected like any other
wrong value, because a reader that carried fields it did not understand would be
guessing about state a human acts on — and a LOWER one is rejected for the
mirror reason: version 2 omits tmux server identity, so defaulting it could
address a different pane with the same id. A version mismatch is an
operator-visible pairing problem: upgrade the other node.

The number lives in one place, `SNAPSHOT_VERSION` in `types.ts`. It was once
four literals — in the type, in `buildLocalSnapshot`, in the validator and again
in `peer.ts` — and the copy in `peer.ts` is why a bump made `peer list` report
every correctly upgraded peer as incompatible.

### Collecting

Per peer, independently, in a bounded pool (`MAX_CONCURRENT_PEERS = 8`) under a
whole-collect deadline (`COLLECT_DEADLINE_MS = 4000`, sized under a tmux
status-bar tick):

1. `ssh <target> murmur export` — one round trip, no arguments. There is never a
   second "refetch from zero" trip, because there is no watermark to be wrong.
2. `parseSnapshot(stdout)`.
3. `replacePeerSnapshot(name, {ok: true, snapshot, at: now})`, which takes
   `host_id`, `display_name`, `murmur_version` and `snapshot_version` out of the
   document itself. The caller passes no metadata alongside it, so the cache
   cannot disagree with the snapshot it holds.

Any failure at any step replaces nothing: `last_attempt_at` and `last_error` are
set, the previous snapshot stands verbatim, and the peer ages into `stale` on its
own. There is no third outcome and no path that writes part of a document.

Concurrency is about the unreachable peers, not the reachable ones. A sleeping
laptop holds a forked ssh client for the full connect timeout, and a serial loop
charged that to every peer behind it: three asleep laptops froze the status bar
for thirty seconds.

`collect` also calls `reconcileLocal` once per invocation, including with zero
peers. That is the only housekeeping left, and it lives here rather than on
`export` because `export` only runs when a peer asks, so a single-machine node
would otherwise reconcile never.

### Alerting

`collect` ends by running `~/.config/murmur/on-attention`, if present and
executable, once per attention event it has not alerted before. It is the one
place that sees every node: local rows, the peer snapshots it just applied, and
the `crashed` rows that only the reconcile just before it can write. Firing
from each writer instead would be instant, but local only, and would leave
`crashed` with no writer to fire it.

An event is `(host_id, server, pane, kind, requested_at)`. `requested_at` is
kept on a repeat and is new after an acknowledgement, so a request raised
again after you cleared it is a new event, and a re-asserted one is not.
`claimAlerts` is `INSERT OR IGNORE` in one immediate transaction, so the status
bar, the dash and the side panel collecting at once fire each event once.
Claims are forgotten an hour after their event leaves every view.

Events older than `ALERT_WINDOW_MS` (15 minutes, on the owning node's clock)
never fire. That covers the backlog on first install, after a store rebuild,
and from a peer that comes back after a long absence: none of it is news. With
no hook installed, nothing is claimed, so installing one later still fires
for anything recent.

The hook is detached, with the event in the environment rather than on stdin:
`murmur status` exits as soon as it prints, and a pipe write still in flight
would be lost. murmur ignores its output and exit code.

### Reconciliation

`reconcileLocal` is the only thing that retires local rows. It consults each
pane and each owner pid once:

| Pane live? | Owner pid alive? | `activity` | Action |
| --- | --- | --- | --- |
| no | yes | — | nothing: tmux's "no panes" can be wrong, a live owner cannot |
| no | no | — | delete the agent row and all attention for the pane |
| yes | yes | — | nothing |
| yes | no | `running` | set `stopped`, upsert `crashed` attention |
| yes | no | `stopped`, pane already `crashed` | nothing: the row says *which* agent died |
| yes | no | `stopped`, no `crashed` row | delete the agent row, **keep** attention |

Then, unconditionally, attention for any pane that no longer exists is deleted —
which is what reaps an attention-only pane whose window was closed.

The asymmetry in the last three rows is the point. A dead *running* owner is an
unreported crash and must leave a durable trace; a dead *stopped* owner finished
normally, so its row is noise, but a `done` it raised is a fact a human has not
yet seen. For the same reason `releaseAgent` deletes the agent row and not its
attention: completion must survive the process exiting.

The two `stopped` rows are one distinction, and the split is load-bearing rather
than pedantic. The crash path sets `activity = stopped` before it raises the
attention, so a literal reading of a single `stopped` row would have the *second*
reconcile delete the row the first had just marked — stripping `agent_name`,
`workstream`, `role` and `cli` one tick after the crash, which is exactly the
information saying which agent died, and breaking the idempotence claimed below.
The `crashed` attention is what tells an owner that finished from one that died
mid-run, so it is the right thing to key on.

`requested_at` is never updated by a repeat, so re-reconciling changes nothing —
crash attention is idempotent for free, and age keeps meaning "how long this has
gone unmet".

A live owner outranks a missing pane because tmux's answer depends on the
caller's environment. A `murmur status` run with a test rig's `TMUX_TMPDIR`
asked about a socket that did not exist, read that as an empty default server,
and deleted every agent on the machine. A pane that really closed takes its
owner with it, so the row goes on the next reconcile. The owner's half of the
same defence: when `setActivity` finds its row missing, the extension claims the
pane again, so an agent wiped by any path reappears on its next event.

The liveness probe **fails closed**. `pidAlive` reports death only on `ESRCH`,
so a probe that cannot answer (`EPERM`) reads as alive. An unknown must never
let a second writer displace a possibly-live owner, and must never manufacture a
crash.

## The view

`paneViews(store, identity, now)` builds `PaneView[]` from `store.localPanes()`
and each cached peer snapshot, through one mapping function. `renderState`
picks one word, `viewSort` orders the list, and `RENDER_PRIORITY` is the single
ordering table `status`, `pick`, and `dash` import rather than restating.

`dash` can reorder for display (`priority` is `viewSort`; `node` is local then
host A–Z; `age` is freshest first). The side panel uses the saved dashboard
order and visibility preferences. Those settings do not change
`RENDER_PRIORITY` or what `status` and `pick` show.

`identity` is required and non-null, because every caller is a command that
already fails without one. Optional-chaining it is what previously classed every
row as remote — including local ones — whenever identity was absent.

### Ordering: one band table, then heuristics inside a band

`RENDER_PRIORITY` decides the band and nothing else may cross one. That is the
only thing a reader is entitled to read off a row's position, so a local `idle`
row in the stream you are working in still sorts below a remote `crashed` one on
a host you cannot reach.

Inside a band, `viewSort` ranks by how much the row wants you. Every input is
already in the snapshot, so this needs no configuration and no new schema:

| Signal | Effect | Why |
| --- | --- | --- |
| age of the **rendered kind** | the main key | `attention.requested_at` per kind, not the pane's `updated_at`, which is the max over every fact on the pane |
| direction of age | `crashed`/`blocked` oldest first, everything else newest first | a request for a human *starves*; a result is *news* |
| extra attention kinds | +15 min each | a pane that crashed *and* was flagged blocked is two requests deep |
| your stream | +10 min | the workstream mu set, else the tmux session name — the same chain the picker's `stream` column prints |
| local | +2 min | a keypress, against an ssh and a nested tmux attach |
| **the pane you are in** | last in its band | you do not need a picker to reach your own cursor |
| **stale host** | after every fresh row in its band | its fields are last-known and may be hours dead |

Bonuses are denominated in **minutes of waiting**, so each is a sentence that
can be checked against a real list rather than a dimensionless weight. Age is
unbounded and the bonuses are not, so no pile of nudges can outrank a genuinely
starving row — which is the guarantee that makes the oldest-first bands safe.

The last two are categorical rather than scored, both deliberately. Scoring
staleness would let an ever-growing age on an unreachable host outrun every fact
we can still verify: an abandoned laptop would own the top of the list, and grow
more convincing the longer it stayed gone.

What is deliberately *not* here: anything needing a past. The store holds
current state only, so time-in-state beyond `requested_at`, flap counts and
learned ranking would each cost a table, a `user_version` bump and a rebuild.
And anything that is an opinion — which workstream matters, whether a `reviewer`
outranks a `worker`, muting a noisy host — is config, and murmur has no config
file yet. Both are follow-on work, not gaps in this.

### State and freshness are different axes, and the ages are two

`stale` is not a state. It is a property of a NODE.

- **Local views are always fresh.** We are the node that authored them.
- **A remote view takes the freshness of its node**: `fresh` when
  `now - fetched_at <= STALENESS_MS` (60s), else `stale`. A peer never reached
  is stale, not fresh — `null` means the first collect has not succeeded yet, and
  an unreachable host you just added must not read as up to date.
- **Freshness is never per agent, and no liveness is inferred for a remote
  pane.** A stale node keeps its last-known fields verbatim, beside an explicit
  "stale host" flag. That is the honest presentation: the fields are real, they
  are simply old, and hiding them would lose the only information available.

On a REACHABLE peer, `stale` is transient by construction and you will rarely
see it: every surface that can render it also refreshes it. `murmur status`
collects inline before it reads, and `pick` paints from cache while starting a
floored collect behind it, so the state exists only in the gap between the
collect floor (30s ± 10s) and `STALENESS_MS` (60s) — and any read landing in
that gap closes it. The flag is durable only for a peer murmur cannot reach,
which is what it is for.

That makes it awkward to exercise by hand, worth knowing before hunting a bug
that is not there: aging `fetched_at` alone shows it, while aging
`last_attempt_at` too makes the peer due and the next read refreshes it away.

Two clocks, and collapsing them shipped a bug where a dead host's agents
rendered as live, because the *replica* really was current:

| | asks | answers |
| --- | --- | --- |
| `fetched_at` (our clock) | how current is my copy | is the host reachable |
| `updated_at` (their clock) | how old is this pane's news | is the row worth believing |

`snapshot_at` is the third and belongs to the peer too: when that node *built*
the document. A peer polled one second ago can be serving a three-hour-old
fact, so `peer list` and `status --json` report both, and the picker shows the
pane's own age rather than ours.

`age()` and `freshness()` are the only two places a duration becomes text or a
verdict.

### Facts only the owner can know are recorded by the owner

Pids, pane liveness and window names mean something only on the machine that
owns them, so reconciliation runs on the owning node and the results travel in
its snapshot.

Do it on the reader and every remote `running` pane is marked `crashed`, which
looks exactly like a real crash and so goes uninvestigated. This is the easiest
thing in the codebase to get backwards, and the model now makes it impossible
rather than merely inadvisable: the reader holds no pid to probe.

The same rule gives names their home. Window ids are machine-local, so resolving
a remote id against the local tmux would label an agent with whatever *this*
machine has at that id. Names travel in the snapshot instead.

### `clear` may only cancel a request for attention

`murmur clear --pane` has two callers, and the single fact either knows is *this
pane's attention has been seen to*. tmux focus hooks run it without `-L`/`-S`:
*the user looked at this pane*, on the server the caller's own tmux names. mu
runs it with `-L <name>` or `-S <path>`, the server read the way `murmur pane`
and `murmur hook mu` read it, to acknowledge a failed turn on a pane of its own
tmux server before it retries, from outside that server. Its only WRITE to
murmur state is one `DELETE FROM attention WHERE pane = ?`, so a focus hook
structurally cannot mutate an agent row — no activity, no identity, no owner
metadata. It does read local panes once, to recompute each pane state and the
window aggregate from stored state.

There is no state focus must refuse to clear, because attention is the only
thing focus can address. That whole class of bug — a whitelist, a resolver call,
a metadata copy-forward, and the reasoning about which states were clearable —
is deleted along with the ability to get it wrong. It was the worst bug found
here: 50 of 84 turns on one agent were cleared within a minute of starting,
because switching back to a pane wiped the state of the agent running in it.

The window state is an aggregate while "you looked" is true of one pane, so
`clear` keeps the window lit when another pane still wants attention. It is
recomputed from attention AND activity, so a busy agent next door keeps the
window showing `running` rather than going dark; `idle` is never published as a
window aggregate, since it is the absence of a signal. Pane state does include
`idle`, so a border can distinguish an idle agent from an ordinary shell. Clear
fails safe by keeping tmux state — wrongly
keeping one is recoverable by focusing the pane, wrongly clearing one loses the
signal — and it is silent and total, because it runs inside the tmux server.

### The single-machine case is the same code path

murmur replaced a 1500-line script that was the daily local tool. Zero peers is
therefore the common case:

- the extension claims its pane and reports activity
- status, pick, dash, and sidepanel read `localPanes()` through the same mapping
  a peer snapshot goes through
- the collector, whenever it runs, iterates the peer list, finds nothing, and
  reconciles once

The surfaces differ in *when* that collect happens:

- **pick never waits for one.** It paints from the cached read
  (`status(store, identity)`) and starts a collect in a DETACHED child
  afterwards, for the next invocation. See `spawnCollect` in `src/cli/pick.ts`
  and the commit that made it so, "paint the picker from cache, collect behind
  it, not before it".
- **dash and sidepanel paint from cache too**, then refresh on a
  `COLLECT_FLOOR_MS` interval while they stay open (`src/cli/dash.tsx` and
  `src/cli/sidepanel.tsx`).
- **status collects inline**, under `COLLECT_FLOOR_MS`, before it reads. tmux
  re-runs it every `status-interval` per attached client; a repaint is not a
  reason to reach a machine.

No network, no ssh, no daemon, no added latency. Federation is strictly
additive: a loop over an empty array. First paint with zero peers measured at
~50 ms against 250 ms for the picker it replaces -- and that number predates the
move to a cached paint, so it is now conservative rather than exact. Re-measure
before quoting it, and say which command produced it.

This is a constraint, not an observation. A tool that only pays for itself at
three nodes charges rent daily for capability used occasionally — one of the
things herdr was rejected for.

## Design choices, and what they cost

**Pull, not push.** "Adhoc ssh" and "an open tunnel" are one model at two
latencies. Both are the reader pulling, and OpenSSH `ControlMaster` collapses
them, because the persisted control socket *is* the tunnel. Push needs a
listener, which is the thing this design does not have.

**The collector never prompts.** It reuses a warm `ControlMaster` socket when
there is one and cold-connects otherwise, so with key auth a peer is visible
whether or not you ssh'd there recently. `BatchMode=yes` makes the cold path
acceptable: no password, passphrase or host-key prompt, so a peer that cannot
authenticate fails fast and shows stale instead of blocking on a human.

Unhandled: a host demanding a hardware-token touch per connection, which
`BatchMode` cannot detect before the token blinks. `hasWarmSocket` exists for
that — gating collect on it per peer would restore the strict posture for those
hosts only. Not wired up, because no peer in use needs it.

**A node being down is the common case, so nothing routine reports it.** A fleet
normally has a laptop asleep and a box switched off. The collector used to write
two lines of ssh diagnostics per failed peer, and it runs from `murmur status`
on every status-bar tick and from `murmur pick` inside a display-popup — so one
sleeping node wrote to stderr several times a minute, forever, and into a UI.

Failures now travel in `collect`'s return value. `murmur collect`, which a human
runs on purpose, is the only thing that prints, and it distinguishes unreachable
(expected, exit 0) from reachable-but-broken (an invalid snapshot, a missing
binary, an auth failure; exit 1). `Permission denied` is deliberately classed as
reachable-but-broken: an auth misconfiguration is an operator task, not a
sleeping laptop, and calling it "asleep, probably" is how a fixable setup error
stays invisible for weeks. Errors are normalised once, where they are caught, so
`peer list`, `status --json` and any SDK consumer get the diagnosis rather than
140 characters of murmur's own ssh invocation.

**Membership is local and asymmetric.** No shared node list, no registry, no
join protocol. Reachability is not symmetric: a laptop reaches a server, and the
server does not reach a laptop behind NAT that sleeps. A global list would
advertise peers half the fleet cannot use. And nothing needs one: only a node
rendering a picker needs targets, and only ones it can reach. Identity is
*discovered* — config holds an ssh target, and the first export returns the
node's `host_id` and display name, which `peer add` records immediately rather
than throwing away.

Asymmetry is design with an unreported consequence: **if B does not peer A, B's
picker cannot see A's agents, and no local surface can say so.** From A
everything reads healthy, because from A it is.

`murmur doctor` surveys each peer over ssh and reports it. Two calls per peer —
`murmur export` for the `host_id`, `murmur peer list --json` for the roster —
because a snapshot structurally cannot carry a roster (below) and `peer list`
carries no `host_id`. Identity is compared on `host_id` only: names are local
handles and `hostname` can be a container id, so comparing by name would report
naming drift as asymmetry and miss genuine duplicates.

Asymmetry is *reported*, never called a fault, and exits 0. Flagging the normal
case — the laptop and the NAT'd server above — would train the operator to ignore
the command. Only a duplicate `host_id`, a snapshot-version mismatch, hook
drift and a codex turn reported twice (hooked, and still on an older `notify`
line naming murmur) are problems, because each is murmur behaving provably
wrongly. Skew is not recomputed: `doctor` calls the same `versionCell` `peer
list` uses.

`doctor` also reads this node's hook harness configs, through the same plan
`murmur init` writes from (`src/hook-install.ts`), so the two cannot disagree
about what "right" is. Those files are shared with mu, museum, muzzle and the
user: murmur owns exactly the handlers whose command starts with `murmur`.
Drift in those is a problem; a harness set up with none of them is an
observation, since only the operator knows whether that is deliberate.

"Island" is scoped to one hop and says so: *no peer that this node surveyed peers
this host*, not "no node in the fleet". `doctor` asks its own peers and stops —
multi-hop survey is a crawler, needing loop detection, a depth bound and a story
for a node reachable from B but not from here, all to report on machines this
node cannot fix anyway.

`doctor --topology` adds the fact hub advice needs and murmur otherwise lacks:
who can reach whom. One `ssh A "ssh B true"` per ordered pair — a bare `true`, so
it measures transport alone, since "unreachable" and "reachable but murmur
missing" have different fixes.

Which node *can* hub is then a set intersection over the matrix, not a
preference. A spoke counts only when reachability is proven in **both**
directions, since the spoke collects from the hub and the hub from the spoke.
When no node qualifies, nothing is recommended and the partition is reported.

Measured while building it: on the author's fleet two peers reach nothing, no
peer can resolve this node's own display name, and no whole-fleet hub exists. A
recommendation would have been wrong.

A failed probe is not a negative. It becomes `unreachable` only when the target
is demonstrably up — it answered this node's survey seconds earlier — and
otherwise it is `unknown`, because a firewall and a sleeping laptop are
indistinguishable from one dial and hub advice built on the confusion would flip
between runs as machines sleep. Nothing a survey learns is written to the store:
it is a diagnostic that reaches out, not state murmur caches, and caching it
would make `peer list` report facts no collect established.

**The snapshot carries no peer roster, deliberately.** Publishing one would be
the obvious way to make the fleet self-describing, and it is refused: a snapshot's
contract is "my panes, complete and authoritative", which is exactly what makes
"absent from a snapshot means absent" true. A roster is neither complete nor
authoritative — it is one node's local configuration, and its truth lives on the
node being described rather than the one describing. Putting membership into that
document would also make every membership question a format question, needing a
version bump and a coordinated fleet upgrade, which is a heavy price so soon
after 0.2.1 given that `parseSnapshot` rejects a mismatched version outright.
Surveying over ssh needs no format change and no fleet-wide upgrade, and it is
honest about what it is: a question asked now, not a fact murmur stores.

**Only `collect` could ever be relayed, which is why there is no broker.** The
paths to a pane's host are not alike:

| surface | needs |
|---|---|
| collect | `ssh <target> murmur export` |
| glance (pick preview / dash pane glance) | `ssh <target> tmux capture-pane -e` |
| jump | `ssh <target>`, interactively |

**A card renders only from collected state; a capture serves one selected pane.**
This is a rule, arrived at by breaking it. An earlier build captured a pane per
visible card so every card could show its agent's model and context. It worked
locally and could never work remotely: a capture per remote row is an ssh per row
per repaint, so the feature was permanently half a feature, and the missing half
is the one murmur exists for. It was reverted in favour of agents reporting those
fields, which every card then draws for free, local or remote. The selected pane
keeps its on-demand capture — a human moved the cursor there and asked for it,
which is the same bargain the preview already makes.

Glance and jump are inherently point-to-point: a captured pane and an interactive
session cannot be served by a third party holding neither. So a relay could only
deduplicate `collect` — and `collect` is the cheap one, ~400 bytes per pane and
~1.2KB per snapshot, measured.

A broker would therefore dedupe the cheapest of the three, leave both interactive
paths untouched, and add a daemon, a port and a second auth story to do it. That
is why gossip and a NATS-style bus lost: they address payload, and payload was
never the problem. The cost was one forked ssh per peer per repaint, fixed by
throttling — see the collect floor in limitation 3.

**Zero knobs.** Every exported setting is one the user can get wrong invisibly.
Two are irreducible: `peers` (only the operator knows their fleet) and `theme`.
Collection concurrency, deadlines and the staleness threshold are constants. The
trade: a wrong constant needs a release, not an edit. Heuristics replace knobs,
so heuristics are where the tests go.

**`driver` distinguishes who is waiting.** An agent you are talking to and an
agent an orchestrator placed want opposite treatment: when the orchestrated one
finishes, its supervisor consumes the result and nobody needs to acknowledge
anything. Same facts, opposite attention. So an orchestrated pi agent raises no
`done` at all (a notify-only harness cannot tell, so it records `done` with
`driver = orchestrated` and the surfaces treat it as crew), and its rows are hidden from status, pick, dash, and sidepanel
unless its attention includes `blocked` or `crashed` — the two kinds only a
human can answer. That list is `NEEDS_HUMAN`, shared by every surface, because
it was two literals in two files. That duplication once hid a row that needed a
human.

It is per *agent*, not per node, because the normal case is one machine running
your session and six spawned workers at once.

A pane reached only through `murmur notify` (codex, cursor, opencode) has no
agent row to carry a driver, so each attention row carries the driver its
requester read from its own environment (`driverFromEnv`: `MU_MANAGED_AGENT=1`
or `MU_AGENT_NAME`). `paneDriver` uses the agent row's driver if there is one,
and otherwise the attention rows' driver. Any `human` request makes the pane
human, so a mixed pane never hides a request a person raised. The same holds per
row: a repeat keeps `requested_at`, so the upsert keeps `human` once a row has
it, and a crew repeat cannot hide an unmet human request.

**Glance, not remote rendering.** "Render any pane from the master" hides two
different problems: a stateless `capture-pane` (cheap, and what the preview
does) and continuous frame streaming with resize negotiation and arbitrary
input routing (most of herdr's codebase). Dash adds buffered prompt submission:
the editor is local, and one tmux command runs on submission. It does not stream
a terminal, negotiate size, or forward each key. Glance remains small because
murmur still does not emulate a terminal.

## Why not something else

Version numbers and roadmap status are deliberately absent here: they were true
on the day they were checked and are the first thing to rot. What follows is the
structural difference, which does not move.

**Terminal multiplexers built for agents** (herdr and similar) own the panes and
infer state by matching terminal output. Two consequences: every machine must run
that multiplexer, which is not a choice you always have, and state is scraped
rather than reported. murmur takes tmux as given and has the agent report from
inside its own process.

**Harness control surfaces** (T3 Code and similar) run a server that owns agent
sessions, with clients over RPC. Their remote *access* is strong. The structural
cost is the adapter: driving an agent you do not live inside needs a per-harness
driver, where murmur's extension runs in-process and calls the store directly.

**Orchestrators** (`mu`) place work and replicate writes from many nodes, so they
need an op-log, watermarks and conflict resolution. murmur observes and never
places work, so single-writer-per-node caching removes all of it. **murmur
observes, mu orchestrates.** Merging is plausible — murmur would give mu global
agent addressing — but remote orchestration is a much harder problem than remote
observation, and it is not murmur's.

Taken from these tools, and worth stating because each is load-bearing above:
integration that rides each agent's own extension mechanism (murmur ships as a
pi package); reusing one authenticated connection; remoteness expressed at the
connection layer rather than by splitting the runtime; identity as a stable UUID
rather than a hostname; and ambient sync with no daemon, where every invocation
syncs before the verb and no watcher outlives the command.

Deliberately not taken: a generic replicated KV. A generic op-log needs conflict
resolution, which single-writer caching skips entirely, and a murmur with
`put`/`del` over arbitrary entities would just *be* mu.

## The extension's lifecycle assumptions

The extension is the only part of murmur that lives inside another program's
process, and every bug in it has come from assuming that process is simpler than
it is.

At load, in order, stopping at the first failure: resolve the pane, load the
identity (never mint one), open the store, and `claimAgent`. Then:

| Outcome | Meaning | What the extension does |
| --- | --- | --- |
| `claimed` | the pane had no owner | keep the `agent_id`, register handlers |
| `retained` | same pid re-claiming | keep the same `agent_id` and activity |
| `replaced` | previous owner is dead, or an `inbox` owner that is not this pi's ancestor | fresh `agent_id`; a dead pi occupant's attention is cleared, an inbox occupant's is kept |
| `refused` | another live process owns the pane | register nothing, paint nothing, close the store |

`retained` is what makes pi's `/reload` a no-op: pi re-runs the extension
factory in the same process, and a check that could not recognise its own claim
would silence the real agent. `refused` is permanent for the process — a nested
agent is deliberately invisible, and it is checked at both the store call and
the tmux publish, because both happen in the same handler.

`replaced` clears the previous occupant's attention because that attention
described a process that is gone, and a human looking at the pane now sees a
different agent.

Handlers are serialised through a single-slot promise chain. `activity` is
last-write-wins, so an inverted `start`/`end` pair would leave a finished agent
`running`.

`setActivity` returning `false` is not an error and is not retried: it means
this process is no longer the owner of record, and the correct response is
silence. Tmux state is published only after an accepted write, so a process
that cannot report cannot publish state either.

Three assumptions that were wrong, all of which failed silently:

- **`session_shutdown` is not "the process is exiting".** pi fires it for
  `/reload`, session switch, resume and fork, then rebinds and continues with the
  same instance. Cleanup belongs there; re-arming belongs in `session_start`,
  which fires afterwards. Treating shutdown as terminal stopped reporting
  permanently on the first `/reload`.
- **`agent_end` is per RUN, and is not the end of the work.** `turn_start` /
  `turn_end` are the per-turn events; one prompt with three tool calls fires one
  `agent_start`, three `turn_end`, one `agent_end`. But `agent_end` can fire
  several times before the agent is finished, because pi re-enters the loop for a
  retry, a compaction or a queued continuation, each with its own `agent_start`.
  So `start, end, start, end, settled` is a normal sequence, and a single
  `agent_end` cannot mean "waiting for a human". `agent_settled` is the event
  that means it: fired once, last. Listening to the wrong event is why the
  highest-attention state in the model had no producer for months.
- **`turn_end` is not a passive notification.** Registering a handler for it
  switches on pi's actionable turn boundary, which must resolve the assistant's
  persisted entry id. During `/new`, pi aborts the run before that entry exists
  and reports a boundary error. Per-turn runtime therefore comes from
  `message_end`, which carries the same assistant message without a boundary.
  pi dispatches `message_end` before it persists the message, so the usage is
  held and written with the context at the next `turn_start` or at `agent_end`,
  both of which follow persistence of the whole turn.
- **The pane outlives the window.** A pane can move between windows, keeping its
  id while the window id changes, so the location is re-read on every report
  rather than cached at startup, and a move retracts the old window's state
  before publishing the new one.

The store handle has three states — `untried`, `open`, `absent` — because those
are three real situations. Collapsing them is what previously latched reporting
off for the life of a process after one transient failure.

The general rule: nothing in the extension may be permanent except "murmur is
not installed here" and "this pane is not mine". Every other giving-up must be
recoverable by the next event, because the process it lives in can run for days
and the user can fix the cause from outside without restarting it.

## Testing posture

Bug-driven, not coverage-driven. A thing earns a test when it can fail *without
you noticing*. `npm test` prints the current size — stating it here has drifted
twice, since every commit that earns a test invalidates it — and the ones that matter
assert what is **impossible** rather than what is implemented:

| Target | Why it can fail silently |
| ------ | ------------------------ |
| A notifier cannot touch an agent row | The corruption it caused looked like a state change |
| `acknowledgePane` cannot change activity | A focus hook wiping a busy agent reads as the agent stopping |
| A second live claimant is refused | A nested run reporting looks like the real agent misbehaving |
| A replaced owner's writes return false | A late write from a dead process corrupts a live row |
| Reconciliation asymmetry | An idle agent vanishing reads as "not there" |
| Whole-snapshot replacement | A pane that should be gone lingers forever |
| Validation before storage | An unknown value reaching a sort or a count |
| No `owner_pid` on any read path | Remote liveness inference creeping back in |
| Freshness derivation | A dead peer showing last-known state as current |
| Jump failure mutating nothing | A keypress deleting a healthy agent |
| An inbox event nested under pi is dropped | A `claude -p` inside pi reporting as the pane's agent |
| pi takes its pane back, keeping attention | A stray inbox claim silencing pi for good |
| The snapshot is byte-identical with inbox rows present | A local column leaking onto the wire and forcing a fleet upgrade |

Several of those are asserted structurally — over the whole returned object
graph, not by reading the type — because a type says what the author intended
and a test says what the object contains.

Not tested: ssh transport (OpenSSH's job), live interactive use, full terminal
rendering, packaging.

That boundary is narrower than it once read. "tmux wrappers" and "TUI
rendering" were listed here as untested and both now are:
`test/mux-targets.test.ts` drives a real tmux server for target syntax, moved
panes and pane-addressed switching; `test/jump.test.ts` asserts wrapper
creation, its session options and the return home; and `test/pick-row.test.ts`
asserts what a row renders. What remains untested is sitting in the result --
attaching by hand and looking at a terminal.

New tests are verified by breaking the code they cover and watching them fail. A
test that has never failed has not been shown to test anything. A test asserting
a *wrong* behaviour has been written twice here, so this step is not ceremony.

Three trap shapes this caught, all in tests rather than code. A `setTimeout(0)`
standing in for a barrier passed about nine runs in ten — worse than a failing
test, because it teaches people to re-run. A `until()` helper that threw on
timeout made a mutation "pass", because the regression died inside the helper
instead of at the assertion describing it. And `expect(output).not.toContain(n)`
over a live number passes for the wrong reason as soon as `n` changes; asserting
over a closed key set is strictly better, and this appeared three separate
times.

Tests must not touch the developer's own state. `stateDir()` is repointed for
every test process, in-process and spawned, and no test addresses the caller's
`$TMUX_PANE`. This is guarded by a test of its own, because it is not
hypothetical: writing the rewrite contract required one `npm run check` to
confirm the tree was green, and that run corrupted the author's live state for
the pane it was running in — the third independent reproduction of the same bug.

Where a fake is the test's weak point, the test talks to the real thing.
`test/mux-targets.test.ts` drives a private tmux server on its own `-L` socket,
because every other test fakes the `Mux` and a malformed tmux target passes them
all — two wrong target spellings did exactly that.

**The thing to know before adding a feature:** most bugs worth fixing here were
invisible to unit tests and to reading the code. A silently no-opping extension,
a remote jump broken by two independent shell-quoting layers, a 75-second hang
on an unreachable peer, ages that measured the wrong clock. All surfaced by
running the thing on two real machines. Unit tests protect the heuristics; they
do not tell you the tool is usable.

## Deliberate non-goals

Each was considered and refused with reasons above:

- a daemon or listening socket
- history of any kind: an event log, a state timeline, an audit trail. The
  inbox is not one: an applied event is deleted, and nothing replays it
- interactive remote terminal rendering
- orchestration or work placement
- a generic put/del op-log
- HLC or clock reconciliation
- gossip replication
- configuration knobs beyond peers, jump commands, and dashboard view
  preferences
- multiplexers other than tmux, channels other than ssh
- in-process integration beyond pi. pi integrates in-process; the other blessed
  harnesses write events, and readers own the store. `murmur notify` stays the
  attention-only path for any harness outside the blessed five: a harness that
  can only run a command when something happens can ask for attention, but
  cannot report activity or ownership.

## Accepted limitations

These are design, not surprise. Each is a consequence of the model above, and
each was cheaper to accept than to solve:

1. **No history.** Only current state is stored. There is no event log, no
   retention horizon, and no way to ask what an agent was doing an hour ago. The
   dash's pane glance is a live `capture-pane`, not a replay.
2. **No compatibility with older nodes.** A pre-rewrite `events.db` is not
   migrated, and any `state.db` from a different `user_version` is rebuilt with
   only peer names and targets salvaged. A change that breaks a released
   build's store moves to a new state directory instead (see
   [State directory](#state-directory)). A node serving the old event format is
   reported as reachable-but-broken, which is the honest description: the two
   cannot federate.
3. **No incremental sync.** Every collect transfers each peer's whole snapshot,
   so it is O(panes) rather than O(changes) — bounded by live pane count, and
   small in absolute terms: ~400 bytes per pane and ~1.2KB for a whole snapshot,
   measured. It is no longer *per tick*, though, and that was the part that
   mattered. Fetch rate used to be tied to redraw rate, because `murmur status`
   collects and tmux re-runs it every `status-interval`; the cost is quadratic in
   a mesh and multiplied again per attached client, since the interval fires per
   client. An ambient collect now skips a peer attempted within
   `COLLECT_FLOOR_MS` ± `COLLECT_JITTER_MS / 2` (30s ± 10s), measured at 1.08s →
   0.05s for `murmur status` against four real peers. Keyed on
   `last_attempt_at`, not `fetched_at`: the expensive peer is the one that does
   *not* answer, since it holds a forked ssh until `ConnectTimeout`, and keying
   on success would exempt exactly the sleeping laptops the floor exists to stop
   hammering. The jitter is drawn per peer per call and is what stops the floor
   becoming a synchroniser — a bare floor makes a fleet converge on hitting one
   machine in the same instant, permanently. A floor is passed by the two
   unattended callers: `murmur status`, which tmux re-runs on a tick, and the
   picker's launch-time background refresh, which runs on every popup open and
   would otherwise fan out ssh per keystroke. The picker itself paints from
   cache and never waits for a collect. `murmur collect` and the picker's `^r`
   are a person asking now, so neither floors — a refresh key that skipped the
   fetch would be a key that silently does nothing.
4. **No nested agents.** A second live process in one pane is refused and
   reports nothing. A pane shows at most one agent.
5. **No remote liveness inference.** `owner_pid` never crosses the wire, so a
   remote pane's `activity` is whatever its own node last said. A stale node
   keeps its last-known values beside a warning, and murmur will not guess.
6. **PID reuse can hide a crash.** If a pane's owner dies and the OS reassigns
   its pid before the next `reconcileLocal`, that owner reads as alive and the
   crash is missed until something else changes. The window is short and the
   failure is temporary; the alternatives (pid start time, cgroups, a watcher)
   each buy a platform dependency for a case measured as rare.
7. **A claim costs a liveness probe, and an unprobeable owner blocks the pane.**
   `claimAgent` fails closed, so a pid that answers `EPERM` refuses the new
   claimant and the pane stays unclaimable until it goes away. Deliberate: the
   alternative is letting a second writer displace a possibly-live owner.
8. **Attention is per pane, not per agent.** A pane whose agent is replaced
   loses the previous occupant's attention, which is intended, and two
   sequential agents in one pane cannot each hold their own `done`.
9. **A peer demanding interactive auth is collectable only while a session is
   open.** Every ssh murmur runs sets `BatchMode=yes` ("never prompt", not
   "never authenticate"), so a host wanting a prompt per connection is reached
   only over an existing master. Ambient collects skip such a peer instead of
   failing on every tick, keep its cached snapshot, and the picker header names
   the fix, `ssh -MNf -S <ControlPath> <host>`: `-N -f` so it holds no session
   slot, `-M -S` so the socket lands where `SSH_OPTIONS` reads, since OpenSSH
   defaults to neither. Eternal Terminal cannot be that master, but it can
   carry one over a port forward, and it is the right place for an operator's
   own work on a capped host, since it holds no ssh session. The operator's
   version is [SSH.md](SSH.md).

   `Session open refused by peer` is slot contention, not auth: a `MaxSessions
   1` host refuses a second channel on one connection, ssh retries on a fresh
   connection and fails auth, and the text ends in `Permission denied`.
   `sessionChannelBusy` keeps the two apart, and `needsInteractiveAuth`
   excludes it explicitly. (An earlier version of this entry blamed a socket
   that had never authenticated; wrong.)

   Accepted costs: the reminder cannot say when a session lapsed, only that
   none exists; `hasWarmSocket` answers "is there a master", not "can I open a
   session", so a busy slot costs one failed, retryable collect. The jump
   (`jumpToAgent`, `ssh -t <host> tmux attach`) holds the slot for the whole
   visit, so an attached operator starves that peer's collects, and a jump to a
   busy slot fails with the same misleading error. Not fixed: a queue in front
   of every ssh, or a second connection per peer, would cost every host to
   serve the rare one. SSH.md says "peek, then back out".

## Known gaps

- **A deadline-cut peer reports `unreachable: false`.** The message says the
  collect deadline passed, which is accurate and is what every surface prints,
  but the flag reads as "reachable". No surface misreports it today; the flag is
  still the wrong shape for that one case.
- **`peer add` cannot always refuse a self-add.** The refusal keys on the
  `host_id` in the probe's snapshot, so a target that fails to answer is added
  on the operator's word. Correct by design, but best-effort rather than a
  guarantee.
- **A host demanding a hardware-token touch per connection is unhandled.**
  `BatchMode` cannot detect the touch before the token blinks. `hasWarmSocket`
  exists for it and is not wired up, because no peer in use needs it.
- **A cursor-agent text from an older generation is a new turn's end.** The
  row keeps only the last ended generation, so a text that arrives after a
  LATER turn has also ended reads as a turn of its own. U0 saw a text trail its
  stop by milliseconds, never by a whole turn.
- **pi's store-free mode reports no pending delegates.** The inbox has no
  word for them, so a settle with delegates out raises `done` for a human-
  driven pi, where the in-process extension would wait.
