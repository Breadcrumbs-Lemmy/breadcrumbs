/**
 * Durable store for net-worth snapshots — the "recorded" half of the trend.
 *
 * The app keeps only *current* balances, so a net-worth trend is mostly
 * back-cast from the transaction record (see `net-worth-trend.ts`). This store
 * is what lets the line become *measured* rather than merely inferred: each time
 * the trend is read, the route records that day's true net worth here, so a
 * month that is a back-cast today is an exact recorded point when it is read
 * back next month (D-N4).
 *
 * Records are keyed by `currency:observedDate`, which makes the upsert
 * **idempotent per calendar day** — viewing the trend ten times in one day
 * leaves one row, not ten, and never double-counts.
 *
 * A net-worth snapshot reveals financial position as plainly as a balance does,
 * so — exactly like the Plaid access tokens (`FilePlaidTokenStore`) — the
 * amounts are encrypted at rest with the shared `FieldCipher` when one is
 * configured, bound to the record's own key so a row cannot be swapped onto
 * another date. Without a cipher the amounts are stored as-is behind the file's
 * 0600 permissions, so the zero-config single-user path is unchanged.
 */
import type { NetWorthSnapshot } from "@ai-fin-os/core";

import { FileKeyValueStore, type KeyValueStore } from "../auth/json-store";
import { FieldCipher } from "../crypto/field-cipher";

export interface NetWorthSnapshotStore {
  /** Every recorded snapshot for a currency, oldest observation first. */
  list(currency: string): Promise<NetWorthSnapshot[]>;
  /** Record (or overwrite) the snapshot for its `observedDate` — idempotent per
   *  calendar day, so repeated trend reads never grow the file. */
  upsert(snapshot: NetWorthSnapshot): Promise<void>;
}

/** The at-rest row: the position figures live inside `amounts` so they can be
 *  encrypted as one field, while the key parts stay in the clear for lookup. */
type StoredSnapshot = {
  currency: string;
  observedDate: string;
  /** JSON `{ netWorthCents, cashCents, debtCents }`, encrypted when a cipher is
   *  configured (else plain JSON). */
  amounts: string;
};

/** One row per `(currency, observedDate)` — the idempotency key. */
function keyOf(currency: string, observedDate: string): string {
  return `${currency}:${observedDate}`;
}

function encodeAmounts(snapshot: NetWorthSnapshot, cipher: FieldCipher | undefined, aad: string): string {
  const json = JSON.stringify({
    netWorthCents: snapshot.netWorthCents,
    cashCents: snapshot.cashCents,
    debtCents: snapshot.debtCents,
  });
  return cipher ? cipher.encrypt(json, aad) : json;
}

function decodeRow(row: StoredSnapshot, cipher: FieldCipher | undefined): NetWorthSnapshot {
  // Legacy plaintext passes through `FieldCipher.decrypt` unchanged, so a file
  // written before a key was configured stays readable.
  const json = cipher ? cipher.decrypt(row.amounts, keyOf(row.currency, row.observedDate)) : row.amounts;
  const amounts = JSON.parse(json) as Pick<NetWorthSnapshot, "netWorthCents" | "cashCents" | "debtCents">;
  return {
    currency: row.currency,
    observedDate: row.observedDate,
    netWorthCents: amounts.netWorthCents,
    cashCents: amounts.cashCents,
    debtCents: amounts.debtCents,
  };
}

/** Sort helper so `list` is deterministic regardless of the map's key order. */
function byObservedDate(a: NetWorthSnapshot, b: NetWorthSnapshot): number {
  return a.observedDate < b.observedDate ? -1 : a.observedDate > b.observedDate ? 1 : 0;
}

/** RAM-only store for tests and ephemeral runs. */
export class InMemoryNetWorthSnapshotStore implements NetWorthSnapshotStore {
  private readonly rows = new Map<string, NetWorthSnapshot>();

  async list(currency: string): Promise<NetWorthSnapshot[]> {
    return [...this.rows.values()]
      .filter((s) => s.currency === currency)
      .map((s) => ({ ...s }))
      .sort(byObservedDate);
  }

  async upsert(snapshot: NetWorthSnapshot): Promise<void> {
    this.rows.set(keyOf(snapshot.currency, snapshot.observedDate), { ...snapshot });
  }
}

/** One JSON file per user, atomic + write-serialised + 0600 (via
 *  `FileKeyValueStore`), with the amounts encrypted at rest when a cipher is set. */
export class FileNetWorthSnapshotStore implements NetWorthSnapshotStore {
  private readonly store: KeyValueStore<StoredSnapshot>;

  constructor(
    filePath: string,
    private readonly cipher?: FieldCipher,
  ) {
    this.store = new FileKeyValueStore<StoredSnapshot>(filePath);
  }

  async list(currency: string): Promise<NetWorthSnapshot[]> {
    return (await this.store.all())
      .filter((row) => row.currency === currency)
      .map((row) => decodeRow(row, this.cipher))
      .sort(byObservedDate);
  }

  async upsert(snapshot: NetWorthSnapshot): Promise<void> {
    const key = keyOf(snapshot.currency, snapshot.observedDate);
    await this.store.put(key, {
      currency: snapshot.currency,
      observedDate: snapshot.observedDate,
      amounts: encodeAmounts(snapshot, this.cipher, key),
    });
  }
}
