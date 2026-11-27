# Setup

Wire murmur after `npm install -g @mu-crew/murmur`. Selling and surface
overview: [README](../README.md). Hard ssh cases: [SSH.md](../SSH.md).

## Per-node init

murmur 3 reads every local pane from its multiplexer: each program reports its
own state over [OSC 7501](https://www.superlogical.com/rex/docs/build/program-status)
(Program Status) and how to relaunch it over
[OSC 7577](https://www.superlogical.com/rex/docs/build/program-resume)
(Program Resume), and the multiplexer keeps both records per pane. That needs
**vtmux >= 3.8-rc3** (or Rex): stock tmux 3.8 drops both sequences, so murmur 3
sees no live state on its local panes (it still lists mu's crew panes and a
foreground `pi`, `claude` or `codex` as `idle`; remote peers running vtmux or
Rex still appear and jump works). **On vanilla tmux 3.8, use murmur 2.x** (`npm i -g
@mu-crew/murmur@2`, branch `release/2.x`): it is the clean out. Using the two
protocols is why murmur 3 no longer needs harness hooks, inboxes, process-chain
walking, a pi extension or `@murmur_*` option publishing.

On every node that runs agents:

```bash
murmur init                      # this node's identity; nothing else to install
```

and in `.tmux.conf` (vtmux >= 3.8-rc3; both options are required):

```tmux
set -s vtmux-program-status on   # keep OSC 7501 records: murmur's only state source
set -s vtmux-program-resume on   # keep OSC 7577 records: resume_command in status --json
```

`murmur doctor` checks both on every local tmux server, and says when a server
is stock tmux. No harness hook, pi extension or focus hook is installed:
harnesses report themselves.

The store lives in `~/.local/state/murmur3` (`$XDG_STATE_HOME/murmur3` when that
is set; `MURMUR_STATE_DIR` moves it). It holds no agent state, only what the
multiplexer cannot remember: since when each pane has held its state, crashes
of panes that vanished mid-work, which alerts have fired, and peers. When the
schema changes, the newer side rebuilds the store and the older side refuses it
rather than rebuilding it back: a CLI verb prints `written by a newer murmur`
and exits 4.

### Coming from murmur 2.x

3.x keeps its state in `~/.local/state/murmur3`, not 2.x's
`~/.local/state/murmur2`. The first 3.x command copies the node's
`identity.json` (the same `host_id`, so peers still know it) and the old store's
peers, and never writes to the old directory. Nothing is migrated under
`MURMUR_STATE_DIR`. Then remove what 2.x installed:

- `pi remove npm:@mu-crew/murmur` (the pi extension), and `/reload` running agents
- the `murmur hook` / `murmur notify` entries in `~/.claude/settings.json`,
  `~/.codex/config.toml`, `~/.cursor/hooks.json` and Muse's settings
- the three `murmur clear` focus hooks in `.tmux.conf` (vtmux clears `done` and
  `error` itself when a pane gains focus)
- any status format reading `@murmur_pane_state`, `@murmur_window_state`,
  `@murmur_session_state` or `@murmur_window_has_agent`: read
  `#{pane_program_state}`, `#{window_program_state}` and
  `#{session_program_state}` instead. `@murmur_count_*` stays.

Once nothing runs 2.x, remove `~/.local/state/murmur2`.

## Which panes murmur lists

One `list-panes -a` per local tmux server, every collect. A pane is listed when
its program keeps an OSC 7501 record or a live OSC 7577 resume record, or when
mu placed it (`@mu_agent` set, or mu's identity in the pane's root environment),
so a crew pane whose program died is never missed. A foreground `pi`, `claude`
or `codex` is listed as `idle` before it reports anything. murmur's seven words, from
the record and the pane's lifecycle:

| Pane | murmur |
| --- | --- |
| retained (`remain-on-exit on`) and dead with a non-zero `pane_dead_status` | `crashed` |
| vanished between two collects while `working`, `waiting` or `blocked` (not a crew worker or delegate that mu closed) | `crashed` (murmur's own row) |
| `blocked` (kind `permission`, `question` or `auth`) | `blocked` |
| `error` | `error` |
| `done` | `done` |
| `working` under the `mu/delegates` record | `waiting` |
| `working` | `running` |
| `idle`, or a word the protocol does not define | `idle` |

Who the agent is comes from the pane options mu sets when it places a worker:
`@mu_agent` (its name, and what makes the pane crew), `@mu_workstream`,
`@mu_role`, `@mu_host` for a remote worker's local pane, and `@mu_pending`
(delegates out, a positive integer; counted only while the pane is `working`
and alive, otherwise ignored). `@mu_pending` fills the agent's `pending`
count only; it never makes the pane `waiting`. A pane without
`@mu_agent` is yours.

Harnesses that speak OSC 7501 natively need nothing: pi (>= 1.1.0), Claude Code
(>= 2.1.295) and Codex (>= 0.164.0). Cursor CLI and Muse Code need a small
hook bridge that writes the sequence to the pane's tty.

A `crashed` row murmur recorded stays until you dismiss it, in the dash or with
`murmur clear --pane %N` (`-L <name>` / `-S <path>` for another tmux server,
`--rex` for a Rex block), or `murmur clear --target <jump_target>` with the
token `status --json` gives each pane (this host's panes only; tsesh's
`ctrl-x` on a crashed agent uses it). Everything else on a pane is its program's, and goes
when the program says so.

## Side panel

Bind the side panel in `.tmux.conf`:

```tmux
bind C-m run-shell "murmur sidepanel"
```

Then press `prefix + C-m` to toggle it for the current window. This key is free
in tmux's default prefix table. `prefix + m` and `prefix + M` are not free: tmux
uses them to set and clear a pane mark.

The panel opens on the left at 25 percent of the window width clamped to
25–40 columns, then shrinks to fit its widest line (never below 16 columns). It
spans the full viewport even when the existing layout is nested, and takes focus. Toggling it again removes only that window's panel.

Press `?` for the live key legend. The side panel and dashboard share compact
mode, sort and visibility settings.

## Notifications

murmur runs `~/.config/murmur/on-attention` (or `$MURMUR_CONFIG_DIR/on-attention`)
once for each new `done`, `blocked`, `error` or `crashed`, on any node. Make it
executable; nothing else is configured. It runs detached, with its output
discarded, and these variables set:

| Variable | Value |
| --- | --- |
| `MURMUR_KIND` | `done`, `blocked`, `error` or `crashed` |
| `MURMUR_AGENT` | the agent name, as the dash shows it |
| `MURMUR_HOST` | the peer name, or this node's display name |
| `MURMUR_LOCAL` | `1` for this node, `0` for a peer |
| `MURMUR_PANE` | the pane id on its node |
| `MURMUR_MESSAGE` | the program's own message (OSC 7501 `msg`), else its title |
| `MURMUR_HOST_COLOR` | the host's accent hex, as the dash colors it |
| `MURMUR_GLYPH` | the kind's Nerd Font glyph, as every murmur surface shows it |
| `MURMUR_KIND_COLOR` | the kind's hex color, as every murmur surface shows it |
| `MURMUR_EVENT` | all of the above and more, as JSON |

```sh
#!/bin/sh
# ~/.config/murmur/on-attention
case "$MURMUR_KIND" in
  done) urgency=low ;;
  *) urgency=critical ;;
esac
notify-send -u "$urgency" "murmur: $MURMUR_AGENT $MURMUR_KIND" \
  "$MURMUR_HOST${MURMUR_MESSAGE:+ — $MURMUR_MESSAGE}"
```

A host's color is a crc32 of its short name over eight Catppuccin accents, the
same hash the mu-crew dotfiles publish as `@mu_crew_host_color`, so one host is one
color in the status bar, the dash, the side panel and your
notifications. For a peer the name
is the one given to `peer add`.

The [mu-crew dotfiles](https://github.com/mu-crew/dotfiles#notifications)
ship a ready hook that turns these into notifications with an icon: a frame in
the host color around the kind's glyph.

On macOS, use `osascript -e "display notification \"$MURMUR_MESSAGE\" with title \"$MURMUR_AGENT $MURMUR_KIND\""`.
For a phone, `curl -d "$MURMUR_AGENT $MURMUR_KIND" ntfy.sh/<topic>`.

The hook fires from `murmur collect`, which `murmur status` runs on each
status-bar tick, as do the dash and side panel. So an event arrives within one
tick, and only on a node that runs one of those. Run the hook on the machine
you sit at; peers need no hook. Each event fires once even when several
surfaces collect at the same time. Events older than 15 minutes do not fire, so
installing the hook does not replay the backlog. An event on the pane you are
looking at (the active pane of the active window of an attached session) is
claimed but not announced, so looking away later does not announce it either.
A crew agent's `done` fires too; filter on `MURMUR_EVENT`'s `driver` if you do
not want it.

## Peers and doctor

On the machine you watch from:

```bash
murmur peer list         # configured peers, last seen
murmur peer list --all   # also ssh hosts that could become peers
murmur peer add devbox
murmur doctor            # survey each peer over ssh
murmur doctor --topology # also probe who can reach whom
```

`peer list` is local. `doctor` dials out, and also checks this node's own
multiplexers: every local tmux server must be vtmux with
`vtmux-program-status on` (and should have `vtmux-program-resume on`), or Rex
must be running ([above](#per-node-init)). Membership is per node: peering a
machine does not mean it peers you — if it does not peer back, its list cannot
see your agents. `doctor` writes nothing and repairs nothing; it prints the
commands. Exit 0 for observations, 1 only for a real problem. Suggestions name
this node as it calls itself; that name may not resolve from the peer's side.
`peer add` accepts a target that does not answer yet and discovers identity on
the first collect.

`--topology` costs one dial per ordered pair. Plain `doctor` answers "is my
fleet mutual?"; `--topology` answers "what shapes are possible here?". A
recommended hub is arithmetic on that matrix. Spokes see the hub and the hub
sees every spoke; **spokes do not see each other** — `export` publishes local
panes only. A pair that was not demonstrably up reads `unknown`, not
unreachable.

Asleep or powered-off nodes are normal. `status`, `dash`, and
`sidepanel` stay silent about that. `murmur peer list` has LAST SEEN; `murmur collect` (run on purpose)
prints one line per peer it could not reach.

murmur has no picker of its own. tsesh >= 1.0.0 binds one to `PREFIX a`: its
agents view lists `murmur status --json --cached` and hands the selected
pane's `jump_target` to `murmur jump`. Any other picker can do the same:

```sh
murmur status --json --cached | jq -r '.panes[] | select(.visible) | .jump_target'
murmur jump '<jump_target>'
```

## One key to the dash and back

After a jump, getting back depends on where the agent lives: a local agent is
an ordinary tmux move, a remote one hands the keyboard to the remote server.
Bind one key that covers both:

```tmux
bind -N "toggle murmur dash" G run-shell -b "murmur dash --goto"
```

Add it on every machine you jump to, not just the one you sit at — on a remote
host it is the remote tmux that reads the key.

`murmur dash --goto` decides in this order:

1. **In a murmur-controlled remote session** it detaches. The wrapper's own
   restore command then returns the local client to where the jump started.
   The client is recognised by tty, pid and creation time; with an older murmur
   on either end it is not recognised, and the key falls through to rule 3.
2. **In the dash** it goes back to the pane you pressed the key in last. If that
   pane is gone it goes to its window. If the window is gone too, it stays in
   the dash and says `nothing to go back to`.
3. **With a dash running** it records where you are and switches to the dash.
   This includes an ordinary `ssh` login to a machine that has its own dash.
4. **With no dash running** it records where you are, opens `murmur dash` in a
   window of the dedicated `murmur-dash` session, and switches to it. On a node
   without `murmur init` it refuses instead, because the dash would exit at once.

The side panel is an ordinary pane, so the key works there and the split is
left alone: back returns you to the panel as you left it.

A dash marks its pane for as long as it runs, and murmur marks the one client
its own jump attaches. The way back is one option per client,
`@murmur_return_<client>`, so two terminals toggling at once do not trade
places. All three are tmux options, so nothing is inferred from process
ancestry or history. A dash killed with `SIGKILL` cannot clear its marker, so
`--goto` checks the pane is still alive before switching and opens a new dash
if it is not.

The `murmur-dash` session has `detach-on-destroy off`: quitting the dash with `q`
moves your client to another session instead of detaching the terminal.

`run-shell -b` backgrounds the call, so the key never blocks the server. The
cost is that a failure message goes nowhere; run `murmur dash --goto` by hand
to see it.

The client mark applies to the next client that attaches to the remote tmux
server. A jump command override that does not itself attach a tmux client, or
attaches after some other client does, leaves the jump unmarked — then `--goto`
switches to the remote host's own dash instead of coming home.

## Rex

[Rex](https://www.superlogical.com/rex/) keeps OSC 7501 records per block
itself, so murmur lists Rex panes beside tmux ones. Each collect makes one
`rex do` call against the local Rex server (never starting one) and reads
window names, pane titles, OSC 7577 resume records and mu labels into the same
shape as a tmux pane. A Rex pane's address is its block id;
`murmur clear --rex --pane block:<id>` dismisses its crash. No Rex, or a Rex
that does not answer, is simply no Rex panes. A crew pane that mu closes
mid-work is not reported as a crash. Rex has no `@mu_role`: a mu agent's pi
reports its role as the OSC 7501 `mu/role` record instead (`idle`, `title`
`orchestrator`, `worker` or `delegate`), so a Rex orchestrator that dies mid-work is
reported as on tmux. One whose mu predates the record has no role and is not.

Remote Rex servers: `murmur peer add|set --rex-host <label>` tells murmur which
Rex server (`rex -S <label>`) owns a peer's panes, so jump, prompt, stop and
glance work on remote Rex panes as on local ones.

### rex-feed: why it exists, and when you need it

Rex.app already shows native OSC 7501 chrome for panes whose program reports
status to Rex directly. `murmur rex-feed` writes one summary tab for what Rex
cannot see or badges badly. It cannot remove Rex.app's native badges on
individual tabs, and without `--exclude-rex` it reports every pane, Rex ones
included:

- **tmux inside Rex tabs, and remote vtmux peers.** A tmux pane keeps the
  record itself rather than pass it to the outer terminal, so Rex.app shows
  nothing for it. `rex-feed` is the only way those agents (local or on another
  machine) reach Rex.app's chrome.
- **Attention filtering.** Rex.app badges every pane equally, including `done`
  crew workers a supervisor owns. The `rex-feed` summary tab applies the same
  filter as the status pill: human-driven agents plus crew agents only when
  `blocked`, `error` or `crashed`.
- **`crashed` rollup.** A pane that vanished mid-work leaves nothing in
  Rex.app; the summary tab keeps it as an error until dismissed.

A pure-Rex fleet works without it: Rex panes report to their own tabs. You want
it there only for the filtered, crash-aware summary, and then the tab duplicates
the native badges. Hybrid users who want only tmux-hosted agents bridged pass
`--exclude-rex`.

Run it in a tab of its own; that tab carries one record per agent the pill
counts, with the most urgent state on its root record.

```sh
rex window new crew -- murmur rex-feed
rex window new crew -- murmur rex-feed --exclude-rex
```

- States map onto the protocol's five: `crashed` and `error` are `error`,
  `blocked` is `blocked` (with the agent's own blocked kind, `question` by
  default), `done` is `done`, `running` and `waiting` are `working`. Idle
  agents get no record.
- Each record's title is the agent's label, prefixed with its host for a
  remote agent; its message is the dash card's one-liner.
- It re-reads every 2 s and fetches peers on the collect floor, as
  `murmur status` does. Ctrl-C clears every record it set.

### dash and jump in a Rex pane

`murmur dash` and `murmur jump` both run in a Rex pane outside tmux. Jumping to
a tmux agent opens it in a new tab of the current Rex session, named after the
agent (`linuxpc · dotfiles` for a remote one): `tmux attach -t <pane>` for a
local agent, the peer's jump command for a remote one. The dash, or whatever
called `murmur jump`, stays where it was. Closing the tab, or detaching, ends
the attach. Jumping to a Rex agent, local or remote, opens no tab: it focuses
the block (`session.focus_block`) and selects its session in Rex.app
(`session.select`).

That tab shows no program status of its own: the agent runs inside tmux, which
keeps the record rather than pass it to the outer terminal. Keep `rex-feed`
running for the fleet's state (see above). An agent started directly in a Rex pane, not in
tmux, reports its own, and murmur lists it as a Rex pane.

The dash's glance and prompt input (`i`) work as in tmux: both address the
agent's pane, not a client. Still tmux-only: `murmur sidepanel` (it lays out
a tmux window) and `murmur dash --goto` (a tmux key binding). In a plain
terminal outside both, `murmur jump` attaches in place and the dash refuses to
start.

## Jump command override

`target` is always ssh (collector). The jump command is for a human and need not
be ssh:

```bash
murmur peer set dev --jump-command 'et dev -c {attach}'
```

murmur substitutes `{attach}` (a quoted `tmux attach` naming the pane's server)
and runs the rest unparsed. `{pane}` is a bare `%N`, so it only reaches the
default server; jumps to a named-server pane refuse it. Default is
`ssh -t <target> env LC_CTYPE=C.UTF-8 {attach}`. The explicit UTF-8 locale
keeps Nerd Font glyphs intact when the remote SSH login has no locale. Override
the command when sshd sets `MaxSessions 1` — see [SSH.md](../SSH.md).

Remote jump from inside tmux opens a local wrapper session named after the peer
with a trailing `~`:

- `status off` — the remote's bar is the only one on screen
- `prefix None` — `^b` goes straight to the remote

Both are per-session. Leaving the remote returns you to the window you jumped
from and destroys the wrapper. Jumping to the same host twice reuses one
session. Outside tmux, in a Rex pane, `dash` and `jump` open a new Rex tab (tmux
agent) or focus the block (Rex agent) as described under Rex. In a plain
terminal outside both, `jump` attaches in place and you land back at your shell
on exit; `dash` refuses to start.

Inside the wrapper the local tmux has no prefix. Escape hatch (root table —
not `M-b` / other Alt letters a picker or the remote may want):

```tmux
bind -n M-Escape if-shell -F '#{m:*~,#{session_name}}' detach-client
```

## Snapshot versions

All nodes must speak the same snapshot format. A mismatch is rejected rather
than guessed — the peer shows as reachable-but-broken with the reason.
`murmur peer list` shows each peer's version. Patch versions that share a
snapshot major interoperate.
