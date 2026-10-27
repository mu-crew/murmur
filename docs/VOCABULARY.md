# murmur vocabulary

- **node** — one machine running murmur, identified by `host_id`.
- **tmux server** — the server that owns a pane. Snapshot protocol v3 represents
  it as exactly one tagged value: `{ "kind": "default" }`,
  `{ "kind": "label", "value": "mule" }`, or
  `{ "kind": "path", "value": "/absolute/socket/path" }`.
- **pane address** — `(server, pane)`. A pane id is unique only within one tmux
  server; `%34` on the default server and `%34` on `tmux -L mule` are different
  addresses.
- **snapshot** — one node's complete current state. Versions are deliberately
  incompatible in both directions; version 6 requires a `driver` on every
  attention entry.
- **driver** — who is waiting on a pane: `human` (you) or `orchestrated` (a
  supervisor such as mu, which consumes the result). An agent row carries its
  agent's driver, and each attention row the driver its requester saw. A pane
  is human if its agent is, or, with no agent row, if any request on it is.
- **activity** — whether the pane's owning process reports `running` or
  `stopped`.
- **attention** — a `done`, `blocked`, `error`, or `crashed` request associated
  with a pane address.
- **freshness** — how recently the reader fetched the node's snapshot.
