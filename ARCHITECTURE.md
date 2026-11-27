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

From 3.0.0, the following interfaces are stable. A breaking change to one of
them requires a major version:

- tmux server options `@murmur_count_<state>` (`crashed`, `error`, `blocked`,
  `done`, `working`, `waiting`, `idle`) and `@murmur_count_crew`, unset at
  zero. They are the only tmux options murmur writes: a pane's, window's and
  session's state are the multiplexer's own (`#{pane_program_state}`,
  `#{window_program_state}`, `#{session_program_state}`).
- the pane options murmur reads, which mu sets on the panes it places:
  `@mu_agent` (name; makes the pane crew), `@mu_workstream`, `@mu_role`,
  `@mu_host`
- the OSC 7501 record id `mu/delegates`: a `working` record under it reads as
  `waiting`
- `murmur status --json` (and `--cached`, which reaches no peer, so
  `peers[].needs_session` there means only "the last attempt was refused on
  auth"; pair it with a detached `murmur collect --quiet --floored` to warm the
  cache for next time). `panes[]` is already in `viewSort` order (most urgent
  first): consumers must not re-sort. Fields:
  - `panes[].pane`, `local`, `agent_name`, `workstream`, `role`, `driver`,
    `activity`, `attention`, `freshness`, `updated_at`
  - address: `panes[].host_id`, `host`, `server` (`{kind:
    default|label|path|rex, value?}`; pane ids are unique only per host and
    server), `session_name`, `window`, `window_name`
  - the program's own words (OSC 7501): `harness`, `title`, `message`,
    `progress`, `blocked_kind`, `pending`; how to relaunch it (OSC 7577):
    `resume_command`, `resume_cwd`; and `cwd`, `pane_title`, `cli`
  - hints: `runs_on` (where a mu remote worker runs), `attached_pane` (a local
    pane already attached to this remote one, `null` with `--cached`),
    `focused` (the operator is looking at it; local only)
  - derived, so consumers do not re-implement murmur's rules: `panes[].render_state`
    (`crashed|error|blocked|done|working|waiting|idle`, tmux vocabulary),
    `label` (the display-name chain), `visible` (belongs in the default list:
    human agents plus crew that needs a human), and `jump_target` (opaque token
    for `murmur jump`; never parse it)
  - `peers[].name`, `needs_session`, `fetched_at`
- `murmur jump <target>`: jumps to the agent a pane's `jump_target` names, after
  a fresh re-read, with attachment focus and hardware-tap confirmation. On
  failure it prints one line on stderr and exits 1 (the caller relays it: a
  `display-popup -E` closes on exit)
- `murmur stop <target> --json`: interrupts the agent a pane's `jump_target`
  names (a mu pi agent by its ctl `abort`, after the socket's `hello` names the
  pane's own agent and workstream; anything else by Escape), then reads the
  pane's state back for up to 5s. Delivery alone is never success. It prints
  one JSON object and exits 0 exactly when `ok` is `true`, else 1:
  - `ok`: `true` only when the pane was seen to leave working
  - `action`: `"stop"`; `jump_target`: the token given
  - `via`: `"ctl"` or `"escape"`; `ctl_fallback`: `null` when `via` is
    `"ctl"`, else why not: `not_local` (remote or Rex pane), `not_pi`,
    `no_identity` (no mu agent and workstream on the pane), `no_socket`,
    `no_answer`, `identity_mismatch` (the socket is another agent's, e.g.
    inherited), `abort_failed`
  - `stopped`: `true` (left working), `false` (still working at the bound) or
    `null` (its state could not be read: unconfirmed, not a guess)
  - `state`: the last state read (`crashed|error|blocked|done|running|waiting|idle`,
    or `gone` for a pane that no longer exists), `null` if none was
  - on failure, `reason` and a one-line `message`: `not_stopped`
    (`stopped: false`), `unconfirmed` (`stopped: null`), `delivery_failed`,
    `invalid_target`, `not_found`. The last three carry no `via`, `stopped` or
    `state`: nothing was sent, or what was could not be.
- the `on-attention` hook: its path in the config dir and the `MURMUR_KIND`,
  `MURMUR_AGENT`, `MURMUR_HOST`, `MURMUR_LOCAL`, `MURMUR_PANE` and
  `MURMUR_MESSAGE` variables it runs with

Everything else, including the store schema and other JSON fields, is internal.

## The shape

```
harness ── OSC 7501 / 7577 ──▶ vtmux (or Rex) keeps a record per pane
                                   │  one list-panes -a per server
                                   ▼
                            local read ── state.db (since, crashes, alerts, peers)
                                   │
                           ssh murmur export
                                   │
                       collector ── view ── status / dash / sidepanel / jump
                                              │
                            jump: local switch, or ssh -t
```

Every harness reports its own state to its terminal over
[OSC 7501](https://www.superlogical.com/rex/docs/build/program-status), and how
to relaunch it over
[OSC 7577](https://www.superlogical.com/rex/docs/build/program-resume). vtmux
(with `vtmux-program-status on`) and Rex keep those records per pane, so a
node's local state is one read of its multiplexer: no hooks, no in-process
extension, no inbox, no process walk. See [The local read](#the-local-read).

Each node reads its own panes fresh on every collect. `murmur export` prints
them as a single complete JSON document — a **snapshot**. Any node pulls its
peers' snapshots over ssh, caches one per peer, and renders the union as an
attention-sorted list. No daemon, no listening socket, no master node.

Three paint surfaces share that list: `status` (counts), `dash` (cards + pane
glance), and `sidepanel` (a compact list in the current tmux window). An
external picker, such as tsesh's agents view, reads `status --json` and hands
the selection to `murmur jump`. Jump is the same whether you left from the
dash, the side panel, or `murmur jump`.
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

| Fact | Meaning | Comes from | Written by |
| --- | --- | --- | --- |
| **activity** | is the program in this pane working | OSC 7501 `working` (and `mu/delegates`) | the program, through its multiplexer |
| **attention** | does someone need to look at this pane | OSC 7501 `done` \| `blocked` \| `error`; `pane_dead_status`; murmur's own `crashed` row | the program; the multiplexer (a dead retained pane); the local read (a pane that vanished mid-work) |
| **freshness** | how recently we reached the node that reported | `peers.fetched_at` | the collector |

They are never folded into one enum. The words a surface paints (`crashed`,
`error`, `blocked`, `done`, `running`, `waiting`, `idle`) are derived at read
time by `renderState`. `waiting` is a stopped agent with outstanding
background work (`pending`, from mu's `mu/delegates` record).

Why three and not one. A crashed agent on an unreachable host is crashed *and*
stale, on different axes; a running agent that is also blocked is both, and the
dash shows both. Every attempt to collapse these produced a question with no
answer.

Identity and address are separated:

- **node identity** — `identity.json`, `{host_id, display_name}`. Created only
  by `murmur init`, and only by it. Survives a store wipe. A 2.x node's identity
  is copied, never minted, on the first run of 3.x (see
  [State directory](#state-directory)).
- **agent identity** — who the agent is, as mu names it in the pane options
  `@mu_agent`, `@mu_workstream` and `@mu_role`. A pane without `@mu_agent` is
  a person's own, unless its root process's environment says mu placed it
  (`MU_MANAGED_AGENT=1`, `MU_AGENT_NAME`, `MU_WORKSTREAM`, `MU_ORCHESTRATOR=1`):
  mu before 5.6.1 could fail to tag. The tag always wins; the environment is
  read once per (pane, pid), cached in the store's `pane_process` table, and
  never for a dead pane, Rex or a remote pane (`@mu_host` set, or `ssh`). On
  macOS only the `ps -E` suffix after the exact argv is environment. `doctor` warns about such a pane. murmur mints no agent ids: a pane's program is whatever its
  multiplexer says is there now.
- **pane address** — the server tag plus pane id. Pane ids are scoped to a
  server, so `%34` on the default server and `%34` on `tmux -L mule` are
  different addresses; a Rex pane is a block id on the `rex` server.

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
  *reports* it and writes nothing. The owning node's next collect sees what
  is really there.
- **Only a pane's own program reports for that pane.** Its multiplexer keeps
  the record the program wrote to its own pty, so nothing else on the machine
  can speak for it: there is no claim to win, no environment to inherit, and
  no event file to forge. murmur adds exactly one word of its own, `crashed`
  for a pane that vanished mid-work, and only the local read can conclude it.

## A tmux server and pane id are the agent's address

Everything below assumes agents run inside vtmux (or Rex). The tagged server and
pane id together are how murmur names an agent and how a jump reaches one.

An agent IS a pane address. A session and a window are only where that pane
currently lives: a pane keeps its id across `move-pane`, `break-pane`, and a window closed
and reopened, while a recorded window id goes stale as a matter of course. So
**only a pane may decide whether an agent exists** — a window id is location,
never evidence of life. tmux says the same thing with its sigils, `$25` / `@75`
/ `%89`, and the three ids are branded types (`SessionId`, `WindowId`, `PaneId`)
so that passing one where another is meant does not compile.

A program started in a plain terminal is in no multiplexer's list and never
appears in murmur's. That is the honest outcome rather than a gap: with no pane
there is no address, and a row you cannot jump to is worse than no row.

`listPanes()` and `livePanes()` return `null` for "could not tell", which is
deliberately distinct from an empty set, and the local read treats `null` as no
evidence and writes nothing. Conflating them deletes every agent on the host the moment
tmux is unreachable. A server that is simply not running (`no server running`,
or a missing socket) is a definite answer, and returns the empty set: reading it
as null left a host whose tmux had died exporting its last panes indefinitely.

The rule binds the JUMP as well as the local read, and that took two goes to
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

**Named-server jump guarantees and limits.** For an agent on a named tmux server
(`-L` / `-S`) on a peer, the jump is addressed by host, tmux server and pane, and
a failure is one line; default-server jumps are unchanged. Murmur does not verify
which pane the local client ends up showing, so some cases are accepted:

- A hand-started `ssh` / `et` pane to a peer may be reused as the attachment even
  when it shows another pane.
- Wrappers without a route stamp (older murmur) are not adopted or retired; the
  jump takes the next free name.
- A custom jump template that redirects the attach is trusted.
- Activity on another tmux client during the jump can change where it lands.

**Routing identity.** Every action that reaches a place re-checks the full
identity of that place where it acts, and declines when it cannot: an ssh argv
is credited to a peer only when `ssh -G` gives the same route (hostname, user,
port, ProxyJump, ProxyCommand); an attach argv names a server only when its tmux
flags positively read as that server; a remote client is `tty pid created`,
since tty and second recur; a wrapper session is reused, retargeted or killed
only when its route stamp matches. `src/routing.ts` holds these checks.

Workaround: start peer connections through murmur (`PREFIX a`, which opens
tsesh's agents view, or `murmur jump`) and keep the default jump template.

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

murmur publishes one set of tmux options, the status pill:
`@murmur_count_<state>` (global), this host's agent counts, one option per state
(`crashed`, `error`, `blocked`, `done`, `working`, `waiting`, `idle`) plus
`@murmur_count_crew`. Unset at zero so a format can test presence. Same fold as
`murmur status` (`statusRollup`), but local only: remote peers still need
`murmur status`. The current values ride along in the same `list-panes`, so an
unchanged pill costs no write. A pane's, window's and session's own state is
vtmux's (`#{pane_program_state}`, `#{window_program_state}`,
`#{session_program_state}`), redrawn by vtmux itself.

## The units

| Unit | Does | Depends on |
| ---- | ---- | ---------- |
| `identity` | Read/create this node's `{host_id, display_name}` | state dir |
| `local` | The local read: one `list-panes -a -F` per tmux server, plus Rex, into `LocalPane[]`; builds this node's snapshot | `mux`, `rex`, `store` |
| `rex` | The Rex reader: `program_status` and `process` per block, fail-silent | the `rex` CLI |
| `pill` | Write `@murmur_count_*` to each tmux server, only where it changed | `mux`, `view` |
| `store` | Local memory (since, crashes), alert claims, peer cache. **The only module touching SQL** | nothing |
| `snapshot` | **Pure.** `parseSnapshot`: validate one document, totally | nothing |
| `view` | **Pure.** `LocalPane[]` and peer snapshots in, `PaneView[]` out | `store` (peers) |
| `channel` | Seam: `exec(target, argv) -> stdout`. One impl: ssh | OS |
| `collector` | Fetch each peer, validate, replace its cache whole; then the local read, the pill and alerts | `channel`, `store`, `local` |
| `mux` | Seam: `list-panes`, server facts, attach, the dash's options. One impl: tmux | OS |
| `legacy-state` | Copy a 2.x node's identity, and a private copy of its store for the peers, on the first run | the 2.x state dir, read only |

`view` and `snapshot` being pure and `store` being the only SQL is the boundary
that carries the design. All three are testable without a machine, a network or
a multiplexer.

**One local read.** `readLocal` is the only way to read local state, and it
returns `LocalPane[]` — the shape a peer's snapshot holds, plus two local-only
facts (`focused`, `runs_on`) that never reach the wire. So `paneViews` maps one
type to `PaneView` exactly once, and a local pane and a remote pane travel the
same code path.

Its one twin is `peekLocal`, behind the SDK's `readStatus`: the same
collectors, with the store's memory read through `Store.peekLocal` instead of
written through `syncLocal`, so a consumer holding a `{ readonly: true }` store
(mural) reads exactly what `status --json --cached` prints without ever
writing, caching a process read or migrating. A live pane the store has not
recorded yet carries `recorded: false` and is aged from the read's `now`.

No pid is in that shape, and none is read: a remote node's processes are not
this node's to probe, and a local pane's liveness is the multiplexer's answer.

The `Store` interface is closed, and adding a method is a contract change. It
holds no agent state at all: no `append`, no log read, no partial-row update,
and no escape hatch exposing the database handle.

Two seams exist with exactly one implementation each: `channel` (ssh) and `mux`
(tmux). Defined so a second backend is possible; not designed for one that does
not exist. Rex is read, not driven, so it is a reader rather than a third seam.
The harness is not a seam at all: it speaks OSC 7501 to its terminal and murmur
never talks to it.

## State directory

Everything murmur keeps lives in `$XDG_STATE_HOME/murmur3` (by default
`~/.local/state/murmur3`): `state.db`, `identity.json` and the compile cache.
`MURMUR_STATE_DIR` moves all of it.

The directory is versioned by breaking change, not by release. 2.x used
`murmur2`, and its schema-12 store holds agent rows 3.0 does not keep, so the
two cannot share one file without each refusing or rebuilding the other's. An
additive change stays in the current directory; the next breaking one moves to
`murmur4`.

The first run of 3.x migrates from the 2.x directory (`$XDG_STATE_HOME/murmur2`,
else `~/.local/state/murmur2`), never under `MURMUR_STATE_DIR`
(`src/legacy-state.ts`). The first identity read that finds none, or the first
open that creates `state.db`, copies `identity.json`, so the host keeps its
`host_id`; that open also takes the old store's peer names, targets and jump
commands, from a private copy of the file and its `-wal` and only when its
schema is one this build reads. Nothing in the old directory is written, moved
or deleted, not even a `-shm`, so 2.x keeps working there.

## The data model

In `state.db` (`STRICT`, `user_version = 13`), only what the multiplexer cannot
remember for murmur:

- `seen` — the last state each live local pane was in, since when, and the
  identity it had (name, workstream, role, driver, harness, cli, title). The
  memory that tells a pane that vanished mid-work from one that finished.
- `crashed` — a pane that vanished while `running`, `waiting` or `blocked`,
  with the identity it was last seen with, until someone dismisses it or a new
  pane takes the address. murmur's one word of its own.
- `alerted` — which [alert](#alerting) events have fired.
- `peers` — the peer cache: one validated snapshot per peer, plus the two
  clocks (`snapshot_at`, the peer's; `fetched_at`, ours).
- `compat` — the oldest schema that can use this file.

Every write is one statement or one `.immediate` transaction. `syncLocal` reads
the previous sightings and writes the new ones, so a deferred transaction would
start as a reader and fail its upgrade with `SQLITE_BUSY_SNAPSHOT` when the
status bar and a dash collect at once; `.immediate` makes the loser wait.

**Reset, not migrate.** A store at an older schema is rebuilt, keeping only the
peers (the one thing a person typed): every other row is re-observed at the next
collect. A store from a newer build is refused, never rebuilt downward,
unless its `compat` stamp admits this build. Salvage, delete and rebuild happen
under one file lock, because deleting the database file is the one operation
SQLite cannot serialise.

## The snapshot

`murmur export` takes no options and prints one complete document. There is no
`--since`, no watermark, no delta form and no JSONL.

```jsonc
{
  "murmur_snapshot": 8,
  "host_id": "1d2ee96e-3a94-41b2-90fa-5f1ee2f04276",  // from identity.json
  "display_name": "macbook-pro",
  "murmur_version": "3.0.0",         // read from package.json, never restated
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
        "activity": "stopped",
        "agent_name": "worker-1",       // @mu_agent; null for a person's own pane
        "workstream": "murmur",         // @mu_workstream
        "role": null,                   // @mu_role
        "driver": "orchestrated",       // crew when @mu_agent is set
        "cli": "node",                  // pane_current_command
        "harness": "codex",             // OSC 7501 `app`
        "pane_title": "Fix auth",       // OSC 0/2, a display-name fallback
        // The program's own words (OSC 7501), every one nullable.
        "title": null,
        "message": "needs input",
        "progress": null,               // 0..100
        "blocked_kind": "question",     // permission | question | auth
        "pending": null,                // outstanding mu delegates
        // How to relaunch it (OSC 7577).
        "resume_command": "codex resume 0b5c",
        "resume_cwd": "/work",
        "cwd": "/work",
        "updated_at": 1788105680000     // when the pane entered its state
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
2. No pid is in it, on purpose. A reader has nothing to probe.
3. A pane with `"agent": null` and `"attention": []` is not emitted, and is
   rejected if a document carries one.
4. `server` is an exact tagged value: `default` has no `value`, `label` has a
   non-empty value, and `path` has an absolute path. A remote path is interpreted
   only on the node that owns it.
5. `panes` order is presentation-only. Emitted sorted by server and pane id so
   the output diffs cleanly; readers sort for themselves.
6. `generated_at` is the *producing* node's clock. What it is not is when the
   reader fetched it — see freshness below.
7. **The program's fields are reported, never inferred.** They are its own
   OSC 7501 and 7577 records, read from the multiplexer. murmur does not derive
   them and does not read them out of the pane.

   The pane scraper (`piFooter`) survives as a *display* fallback for the one
   selected card, and only there. It produces a string for a human, never values
   for a row, and nothing it produces enters a snapshot.

`buildSnapshot` takes a fresh local read, never a cache, which is what makes
the document authoritative: a snapshot built from remembered rows would publish
agents whose panes are gone, and a reader has no way to tell.

**Validation is total and strict**, and happens before storage.
`parseSnapshot` rejects an unknown key, a missing key, a wrong type, a
`murmur_snapshot` other than `8`, a malformed server tag, an unknown `activity`,
`driver`, `kind` or `blocked_kind`, a `progress` outside 0..100, a negative
`pending`, a duplicate server/pane address, and a pane that is neither an agent
nor an attention. Nothing is
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
four literals — in the type, in the builder, in the validator and again
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

`collect` also makes the local read once per invocation, including with zero
peers, then writes the pill from it. It lives here rather than on `export`
because `export` only runs when a peer asks, so a single-machine node would
otherwise never notice a pane vanish.

### Alerting

`collect` ends by running `~/.config/murmur/on-attention`, if present and
executable, once per attention event it has not alerted before. It is the one
place that sees every node: the local read, the peer snapshots it just applied,
and the `crashed` rows only the local read can conclude.

An event is `(host_id, server, pane, kind, requested_at)`. A local pane's
`requested_at` is when it entered its state (`pane_program_state_time`, else
the collect that first saw the state), so a state that holds is one event
however many collects see it, and a pane that works and finishes again is a
new one.

An event on the pane the operator is looking at — the active pane of the active
window of an attached session, read in the same `list-panes` — is claimed and
not fired: they already see it, and claiming it means looking away later does
not announce something they watched happen. Focus is local only; a peer's
events always fire.
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

### The local read

`readLocal` is the only thing that reads local state, and `Store.syncLocal` the
only thing that writes what it concluded:

1. One `list-panes -a -F` per tmux server: every socket in tmux's directory,
   `$TMUX`'s, and every server a previous collect saw (whose "no server running"
   is what retires its panes). The format carries the address, `pane_dead` and
   `pane_dead_status`, the focus expression, the OSC 7501 record
   (`pane_program_state`, `_kind`, `_progress`, `_app`, `_title`, `_message`,
   `_id`, `_state_time`), the OSC 7577 record (`pane_resume_command`, `_cwd`),
   the `@mu_*` options and the pill's current values. Free text is escaped so a
   `|` cannot split a row.
2. Rex, when it runs: `session.list`, `session.list_blocks`, then
   `program_status` and `process` per block, never starting a server. Any
   failure is "no Rex", never an error and never a crash.
3. A pane is listed when it has a program record or an `@mu_agent`, so a crew
   pane whose program died is never missed, or when its foreground program is
   a known harness (`pi`, `claude`, `codex`), directly or run by `node`/`bun`
   (told from the root process's argv, in the same cached read). Its word:

| Pane | Word |
| --- | --- |
| dead, `pane_dead_status` not 0 | `crashed` |
| `blocked` / `error` / `done` | the same |
| `working` under `mu/delegates` | `waiting` |
| `working` | `running` |
| anything else | `idle` |

4. `syncLocal` folds in what the multiplexer cannot remember. Since when each
   pane has held its state (the multiplexer's `state_time` when it has one, else
   carried while the state holds). And a pane present last time and absent now:
   gone while `running`, `waiting` or `blocked` is a crash, recorded in
   `crashed` with the identity it was last seen with; gone at rest is a pane
   that finished. A server read as null (a timeout, a permission error) is no
   evidence and changes nothing — treating it as empty would paint every agent
   on it `crashed`.

A live pane at a crashed address is a new occupant and clears the crash.
Otherwise a crash stays until dismissed: `murmur clear`, or the dash, which is
the one attention a person acknowledges. Every other attention is the
program's own, and vtmux clears `done` and `error` itself when the pane gains
focus.

## The view

`paneViews(store, identity, local, now)` builds `PaneView[]` from one local read
and each cached peer snapshot, through one mapping function. `renderState`
picks one word, `viewSort` orders the list, and `RENDER_PRIORITY` is the single
ordering table `status` and `dash` import rather than restating.

`dash` can reorder for display (`priority` is `viewSort`; `node` is local then
host A–Z; `age` is freshest first). The side panel uses the saved dashboard
order and visibility preferences. Those settings do not change
`RENDER_PRIORITY` or what `status` shows.

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
| your stream | +10 min | the workstream mu set, else the tmux session name |
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
collects inline before it reads, and the dash and side panel paint from cache
and collect on the floor while open, so the state exists only in the gap between the
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
fact, so `peer list` and `status --json` report both, and a row shows the
pane's own age rather than ours.

`age()` and `freshness()` are the only two places a duration becomes text or a
verdict.

### Facts only the owner can know are recorded by the owner

Pane liveness, crashes and window names mean something only on the machine that
owns them, so the local read runs on the owning node and its conclusions travel
in its snapshot.

Do it on the reader and every remote `running` pane whose node went quiet is
marked `crashed`, which looks exactly like a real crash and so goes
uninvestigated. The model makes it impossible rather than merely inadvisable: a
reader holds only documents, nothing to probe.

The same rule gives names their home. Window ids are machine-local, so resolving
a remote id against the local tmux would label an agent with whatever *this*
machine has at that id. Names travel in the snapshot instead.

### `clear` may only dismiss murmur's own word

`murmur clear --pane` (and the dash's acknowledge) removes one thing: a
`crashed` row murmur recorded for a pane that vanished mid-work. Its only write
is one `DELETE FROM crashed` keyed on the pane address, so it structurally
cannot touch a program's state. Everything else on a pane is the program's own
record, which vtmux clears itself (`done` and `error` when the pane gains
focus; `blocked` when the program moves on), so there is nothing else for murmur
to clear, and nothing that can wipe a busy agent's state on focus, the worst
bug 2.x shipped.

### The single-machine case is the same code path

murmur replaced a 1500-line script that was the daily local tool. Zero peers is
therefore the common case:

- each program reports itself to vtmux
- status, dash, and sidepanel read `readLocal()` through the same mapping
  a peer snapshot goes through
- the collector, whenever it runs, iterates the peer list, finds nothing, and
  makes the local read once

The surfaces differ in *when* that collect happens:

- **`status --cached` never waits for one.** It makes the local read and
  reads cached peers only; an
  external picker pairs it with a detached `murmur collect --quiet --floored`
  so the next invocation finds a warm cache.
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
on every status-bar tick and from a picker inside a display-popup — so one
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
the command. Only a duplicate `host_id`, a snapshot-version mismatch, and a
local tmux server murmur cannot read (stock tmux, or vtmux with
`vtmux-program-status` off) are problems, because each is murmur provably
unable to do its job. Skew is not recomputed: `doctor` calls the same `versionCell` `peer
list` uses.

`doctor` also asks this node's multiplexers what they can report: each local
tmux server's `#{vtmux_version}` and its `vtmux-program-status` and
`vtmux-program-resume` options, and whether Rex answers. Resume off is an
observation (panes carry no `resume_command`); no tmux server and no Rex at all
is an observation too, since a node may run no agents.

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
| glance (dash pane glance) | `ssh <target> tmux capture-pane -e` |
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
anything. Same facts, opposite attention. So an orchestrated agent's `done` is
crew, and its rows are hidden from status, dash, and sidepanel
unless its attention includes `blocked` or `crashed` — the two kinds only a
human can answer. That list is `NEEDS_HUMAN`, shared by every surface, because
it was two literals in two files. That duplication once hid a row that needed a
human.

It is per *agent*, not per node, because the normal case is one machine running
your session and six spawned workers at once.

The driver comes from the pane: `@mu_agent` set is crew, unset is a person's
own. Each attention row carries the same driver, so a crash row murmur kept
after the pane is gone still says who should hear about it. `paneDriver` uses
the agent's driver, and otherwise the attention rows': any `human` request
makes the pane human, so a mixed pane never hides a request a person raised.

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
rather than reported. murmur reads what the agent reports itself, over an open
protocol (OSC 7501) that vtmux and Rex both keep.

**Harness control surfaces** (T3 Code and similar) run a server that owns agent
sessions, with clients over RPC. Their remote *access* is strong. The structural
cost is the adapter: driving an agent you do not live inside needs a per-harness
driver, where murmur needs none: every harness speaks the same OSC 7501.

**Orchestrators** (`mu`) place work and replicate writes from many nodes, so they
need an op-log, watermarks and conflict resolution. murmur observes and never
places work, so single-writer-per-node caching removes all of it. **murmur
observes, mu orchestrates.** Merging is plausible — murmur would give mu global
agent addressing — but remote orchestration is a much harder problem than remote
observation, and it is not murmur's.

Taken from these tools, and worth stating because each is load-bearing above:
reported rather than scraped state; reusing one authenticated connection; remoteness expressed at the
connection layer rather than by splitting the runtime; identity as a stable UUID
rather than a hostname; and ambient sync with no daemon, where every invocation
syncs before the verb and no watcher outlives the command.

Deliberately not taken: a generic replicated KV. A generic op-log needs conflict
resolution, which single-writer caching skips entirely, and a murmur with
`put`/`del` over arbitrary entities would just *be* mu.

## Testing posture

Bug-driven, not coverage-driven. A thing earns a test when it can fail *without
you noticing*. `npm test` prints the current size — stating it here has drifted
twice, since every commit that earns a test invalidates it — and the ones that matter
assert what is **impossible** rather than what is implemented:

| Target | Why it can fail silently |
| ------ | ------------------------ |
| A null server read synthesises no crash | A tmux hiccup painting every agent `crashed` |
| A pane vanishing mid-work crashes; at rest it does not | A finished agent reported dead, or a dead one missed |
| `mu/delegates` reads as `waiting` | A waiting agent counted as working |
| `clear` deletes only murmur's crash row | A dismiss reaching a program's own state |
| A focused pane's event is claimed, not fired | A notification for what you watched happen |
| Whole-snapshot replacement | A pane that should be gone lingers forever |
| Validation before storage | An unknown value reaching a sort or a count |
| Local-only facts never reach the wire | Focus or `@mu_host` leaking and breaking every peer |
| Freshness derivation | A dead peer showing last-known state as current |
| Jump failure mutating nothing | A keypress deleting a healthy agent |
| The suite cannot reach live tmux or Rex | A test run writing the developer's pill or reading their panes |

Several of those are asserted structurally — over the whole returned object
graph, not by reading the type — because a type says what the author intended
and a test says what the object contains.

Ink `renderToString` tests check dash and side-panel frames; tmux tests
check pane-addressed switching and wrapper setup. Live terminal interaction
still needs a manual check; SSH transport belongs to OpenSSH.

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
invisible to unit tests and to reading the code. A remote jump broken by two independent shell-quoting layers, a 75-second hang
on an unreachable peer, ages that measured the wrong clock. All surfaced by
running the thing on two real machines. Unit tests protect the heuristics; they
do not tell you the tool is usable.

## Deliberate non-goals

Each was considered and refused with reasons above:

- a daemon or listening socket
- history of any kind: an event log, a state timeline, an audit trail
- interactive remote terminal rendering
- orchestration or work placement
- a generic put/del op-log
- HLC or clock reconciliation
- gossip replication
- configuration knobs beyond peers, jump commands, and dashboard view
  preferences
- multiplexers other than vtmux and Rex, channels other than ssh
- any per-harness integration: a harness that does not speak OSC 7501 gets a
  bridge that writes the sequence, not a murmur code path
- stock tmux, which drops OSC 7501: that is murmur 2.x (`release/2.x`)

## Accepted limitations

These are design, not surprise. Each is a consequence of the model above, and
each was cheaper to accept than to solve:

1. **No history.** Only current state is stored. There is no event log, no
   retention horizon, and no way to ask what an agent was doing an hour ago. The
   dash's pane glance is a live `capture-pane`, not a replay.
2. **No compatibility with older nodes.** Incompatible older stores keep only
   configured peers. A
   change that breaks a released
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
   unattended callers: `murmur status`, which tmux re-runs on a tick, and
   `murmur collect --floored`, the background refresh an external picker starts
   on every popup open, which would otherwise fan out ssh per keystroke. Plain
   `murmur collect` is a person asking now, so it does not floor — a refresh
   that skipped the fetch would be a command that silently does nothing.
4. **No nested agents.** A pane shows the record its multiplexer keeps for it:
   vtmux's summary record, the most urgent one. A child tool (a build, a test
   runner) that reports OSC 7501 into an agent's pane can outrank the agent.
5. **No remote liveness inference.** No pid crosses the wire, so a remote
   pane's `activity` is whatever its own node last said. A stale node keeps its
   last-known values beside a warning, and murmur will not guess.
6. **A pane that dies and is replaced between two collects is no crash.** A new
   pane at the same address is a new occupant. Retained panes
   (`remain-on-exit on`, as mu sets) report their exit status directly and are
   not affected.
7. **Crash detection needs a collect.** A pane that vanishes mid-work is seen
   gone only at the next collect (a status-bar tick, the dash, the side panel),
   and only on a node that runs one.
8. **Attention is per pane, not per agent.** A pane whose program is replaced
   loses the previous occupant's attention, which is intended, and two
   sequential programs in one pane cannot each hold their own `done`.
9. **A peer demanding interactive auth is collectable only while a session is
   open.** Every background ssh murmur runs sets `BatchMode=yes` ("never
   prompt", not "never authenticate"); the attach is `ssh -t` and, with a
   `jump_command`, runs that instead. A host wanting a prompt per connection
   is reached only over an existing master. Ambient collects skip such a peer
   instead of failing on every tick, keep its cached snapshot, and the dash header names
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
- **A server that cannot be asked drops out of the snapshot.** Its panes are
  not crashed (a null read is no evidence), but they are not published either,
  so a peer briefly sees them gone. They return, with their age, at the next
  read that succeeds.
- **Stock tmux shows no local panes.** It drops OSC 7501; `doctor` says so.
