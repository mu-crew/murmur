# murmur vocabulary

- **node** — one machine running murmur, identified by `host_id`.
- **server** — the tmux or Rex server that owns a pane. Its address is one tagged value: `{ "kind": "default" }`,
  `{ "kind": "label", "value": "mule" }`,
  `{ "kind": "path", "value": "/absolute/socket/path" }`, or `{ "kind": "rex" }`
  (this machine's Rex).
- **pane address** — `(server, pane)`. A pane id (a tmux `%N`, or a Rex block
  id) is unique only within one server; `%34` on the default server and `%34` on `tmux -L mule` are different
  addresses.
- **snapshot** — one node's complete current state. Versions are deliberately
  incompatible in both directions.
- **driver** — who is waiting on a pane: `human` (you) or `orchestrated` (a
  supervisor such as mu, which consumes the result). A pane's driver is its
  agent's: `orchestrated` when mu placed it as crew, else `human`.
- **activity** — whether the pane's owning process reports `running` or
  `stopped`.
- **attention** — a `done`, `blocked`, `error`, or `crashed` request associated
  with a pane address.
- **freshness** — how recently the reader fetched the node's snapshot.
