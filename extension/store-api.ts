import type { NodeIdentity } from "../src/identity.js";
import type { Store } from "../src/store.js";

export type StoreModule = {
  loadIdentity(): NodeIdentity | null;
  openStore(): Store;
};
