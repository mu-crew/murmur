# ssh for murmur

murmur rides whatever ssh already works, so a host that takes key auth
unattended needs nothing here. Read on when a peer will not collect and the
error looks like credentials.

## The one rule

murmur never prompts: every ssh it runs sets `BatchMode=yes`. A peer that
cannot authenticate unattended is collectable only while an authenticated
connection exists for murmur to ride. The rest of this page follows from that.

## A host that wants interactive auth

For a host that asks for a second factor, a token or a password per
connection, open a master once and leave it running:

```sh
ssh -MNf -S '~/.ssh/control/%r@%h:%p' dev   # answer the prompt once
```

`-N -f` open no shell and background it, so the master holds no session slot.
`-M -S` put the socket where murmur looks; OpenSSH defaults to no master and
no `ControlPath`, so a bare `ssh` may leave nothing to ride. If your
ssh_config already sets `ControlMaster auto` and a matching `ControlPath`, a
plain `ssh dev` does the same.

While no master lives, the peer is skipped, its cached rows keep their age,
and the picker names the fix (`murmur doctor` has the full list):

```
! dev: re-auth needed (last seen 2h) — ssh -MNf -S ~/.ssh/control/%r@%h:%p dev
```

## A host that caps sessions per connection

`Session open refused by peer` with a master running is not an auth problem.
A host may set `MaxSessions 1`, so one connection carries one session and a
second command over the same socket is refused. ssh then falls back to a fresh
connection, which fails auth, and the line that survives in logs is the
misleading one:

```
mux_client_request_session: session request failed: Session open refused by peer
alice@dev: Permission denied (keyboard-interactive).
```

murmur tells this apart from a real auth failure and retries
(`sessionChannelBusy` in `src/collector.ts`). `ControlMaster no` does not
prevent the fallback.

The cap lives only in the host's `sshd_config`; no client option changes it.
What you can do is stop competing for the slot:

- **Your own work: use Eternal Terminal.** Once connected it holds no ssh
  session. An interactive `ssh` holds one for as long as it is open.
- **Jumping is a session.** `ssh -t <host> … tmux attach` holds the slot while
  you are attached, so the peer goes stale until you detach, and a jump to a
  busy peer fails with the same misleading error. Peek, then back out.
- **Long remote commands: use [mule](https://github.com/mu-crew/mule).** The cap
  is per connection, and mule keeps its own master and dispatches jobs
  detached, holding the slot only briefly. Collects stay on murmur's own retry:
  they are already sub-second.

mule's master is a second one, on its own socket, so it needs its own prompt.
If you script around mule, its exit 3 means "ask a human", never "retry".

### Carrying the master inside ET

ET can also carry a master. Forward a local port to the host's sshd
(`et -N -t 2222:22 dev`), point the peer at it, and open the master as above:

```sshconfig
Host dev
  HostName localhost
  Port 2222
  HostKeyAlias dev.example.com   # the host's real name
```

murmur takes the `ControlPath` from ssh, so it needs no change; use one local
port per host. The master then lasts as long as the ET session, not the
network connection. How the host authenticates a connection that arrives this
way is up to its sshd, so check before relying on it.

## Recovery: a wedged master

`ssh -O check` says `Master running` but every command over the socket fails.
Rebuild it, and kill its `ProxyCommand` child too, which outlives the master
and poisons the replacement:

```sh
pkill -f 'ssh -MNf dev'                     # the master
pkill -f '<proxy command> .*dev'            # its ProxyCommand child, if any
rm -f ~/.ssh/control/'<user>@<host>:22'     # the stale socket
ssh -MNf -S '~/.ssh/control/%r@%h:%p' dev   # rebuild
ssh -O check dev                            # expect: Master running (pid=...)
```

## Reading the fleet

`murmur peer list` is best-effort: the **`SSH`** column is last-known
reachability, **`error`** is the current attempt. Branch on the error, never on
presence in the list; `--json` exits 0 with peers down, since sleeping machines
are normal.

`murmur status` and `murmur pick` poll and stay silent. `murmur collect` dials
and prints one line per unreachable host: run it to ask "can I reach this host
right now".
