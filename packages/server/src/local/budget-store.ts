import type { Budget, BudgetPeriodBasis } from "@ai-fin-os/core";
import { homedir } from "node:os";
import { join } from "node:path";

import { FieldCipher } from "../crypto/field-cipher";
import { readJsonFile, writeJsonFileAtomic } from "../persistence/atomic-file";

/** Same envelope shape as the statement store: an encrypted budget file is
 *  `{ "$enc": "bcenc1:…" }`, a legacy/plaintext file is the bare state. */
type EncryptedStateEnvelope = { $enc: string };

/** Domain-separation label bound as GCM additional data, distinct from every
 *  other store's, so a budget blob can never be decrypted as some other kind of
 *  encrypted field. */
const BUDGET_STATE_AAD = "budget-state";

const DEFAULT_CURRENCY = "USD";

/**
 * A user's configured budgets: per-category caps (each governing a week or a
 * month) plus an optional overall cap per window. This is *intent*, not history
 * — the store holds only what the user set; progress is computed on the fly from
 * their transactions. Small and whole-set: the UI edits it as one object, so the
 * store replaces it as one.
 */
export type BudgetState = {
  currency: string;
  /** Optional single overall monthly cap in integer cents; null = none. */
  overallLimitCents: number | null;
  /** Optional single overall weekly cap in integer cents; null = none. Distinct
   *  from the monthly overall cap so a user can hold both at once. */
  overallWeeklyLimitCents: number | null;
  budgets: Budget[];
};

/** What a caller must supply to `save`. `overallWeeklyLimitCents` may be omitted
 *  by a caller written before weekly caps existed — it normalises to null — so
 *  older code keeps compiling and working. `load` always returns it populated. */
export type BudgetStateInput = Omit<BudgetState, "overallWeeklyLimitCents"> & {
  overallWeeklyLimitCents?: number | null;
};

export interface BudgetStore {
  load(): Promise<BudgetState>;
  save(state: BudgetStateInput): Promise<BudgetState>;
}

const EMPTY_STATE: BudgetState = {
  currency: DEFAULT_CURRENCY,
  overallLimitCents: null,
  overallWeeklyLimitCents: null,
  budgets: [],
};

export class InMemoryBudgetStore implements BudgetStore {
  private state: BudgetState;

  constructor(initialState: BudgetState = EMPTY_STATE) {
    this.state = normalizeState(initialState);
  }

  async load(): Promise<BudgetState> {
    return cloneState(this.state);
  }

  async save(state: BudgetStateInput): Promise<BudgetState> {
    this.state = normalizeState(state);
    return cloneState(this.state);
  }
}

export class FileBudgetStore implements BudgetStore {
  /** Serialises writes so two near-simultaneous saves (two tabs editing budgets)
   *  cannot interleave and drop one. Same guard the statement store uses. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath = defaultBudgetStorePath(),
    /** When set, the whole budget blob is encrypted at rest — budgets reveal
     *  financial intent (what a user is trying to cut), so they get the same
     *  envelope as transactions. Absent = plaintext behind file permissions. */
    private readonly cipher?: FieldCipher,
  ) {}

  async load(): Promise<BudgetState> {
    const raw = await readJsonFile<Partial<BudgetState> & Partial<EncryptedStateEnvelope>>(this.filePath, {});
    if (raw && typeof raw === "object" && typeof (raw as EncryptedStateEnvelope).$enc === "string") {
      // Encrypted on disk. Without a key we must not silently return an empty
      // set and let the next save overwrite the user's real budgets — fail loud.
      if (!this.cipher) {
        throw new Error(
          "Budget store is encrypted but no encryption key is configured (BREADCRUMBZ_ENCRYPTION_KEY).",
        );
      }
      const plaintext = this.cipher.decrypt((raw as EncryptedStateEnvelope).$enc, BUDGET_STATE_AAD);
      return normalizeState(JSON.parse(plaintext) as Partial<BudgetState>);
    }
    // No `$enc`: legacy plaintext (or empty). Readable with or without a cipher;
    // a configured cipher re-seals it on the next save.
    return normalizeState(raw as Partial<BudgetState>);
  }

  save(state: BudgetStateInput): Promise<BudgetState> {
    const next = this.queue.then(async () => {
      const normalized = normalizeState(state);
      await this.persist(normalized);
      return normalized;
    });
    // Keep the chain alive even if one write throws, so a single failure does
    // not wedge every later save behind a rejected promise.
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Crash-safe (temp-write-then-rename) and mode 0600 either way — see
   *  persistence/atomic-file — and encrypted when a cipher is configured. */
  private async persist(state: BudgetState): Promise<void> {
    const payload: BudgetState | EncryptedStateEnvelope = this.cipher
      ? { $enc: this.cipher.encrypt(JSON.stringify(state), BUDGET_STATE_AAD) }
      : state;
    await writeJsonFileAtomic(this.filePath, payload);
  }
}

export function defaultBudgetStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.BREADCRUMBZ_LOCAL_DATA_DIR?.trim();
  const dataDir = configured && configured.length > 0 ? configured : join(homedir(), ".breadcrumbz", "local-data");
  return join(dataDir, "budgets.json");
}

/** A positive integer cap in cents, or null. Shared by both overall caps. */
function normalizeOverall(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0
    ? value
    : null;
}

/**
 * Coerce whatever is on disk (or injected) into a valid state. Defensive so a
 * hand-edited or partially-written file never crashes a read: a non-positive or
 * malformed cap is dropped, a duplicate (window, category) collapses to the
 * first, and a bad overall cap becomes "none". The route validates on the way
 * in; this is the belt to that suspenders.
 */
export function normalizeState(input: Partial<BudgetState> | undefined | null): BudgetState {
  const currency =
    typeof input?.currency === "string" && input.currency.length === 3
      ? input.currency.toUpperCase()
      : DEFAULT_CURRENCY;

  const overallLimitCents = normalizeOverall(input?.overallLimitCents);
  const overallWeeklyLimitCents = normalizeOverall(input?.overallWeeklyLimitCents);

  const budgets: Budget[] = [];
  // Uniqueness is per (window, category): a category may hold one weekly cap and
  // one monthly cap, but not two of either. An unknown/omitted period is monthly.
  const seen = new Set<string>();
  if (Array.isArray(input?.budgets)) {
    for (const candidate of input.budgets) {
      const category = typeof candidate?.category === "string" ? candidate.category.trim() : "";
      const limitCents = candidate?.limitCents;
      if (category.length === 0) continue;
      if (typeof limitCents !== "number" || !Number.isInteger(limitCents) || limitCents <= 0) continue;
      const basis: BudgetPeriodBasis = candidate?.period === "week" ? "week" : "month";
      const dedupeKey = `${basis}:${category}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      // Omit `period` for a monthly cap so the on-disk shape is unchanged from
      // before weekly caps existed (back- and forward-compatible); only a weekly
      // cap carries the field.
      budgets.push(basis === "week" ? { category, limitCents, period: "week" } : { category, limitCents });
    }
  }
  // Stable order on disk and in responses, independent of edit order: by category,
  // then window (month before week), so a category's two caps sit adjacently.
  budgets.sort((a, b) => {
    const byCategory = a.category.localeCompare(b.category);
    if (byCategory !== 0) return byCategory;
    return (a.period ?? "month").localeCompare(b.period ?? "month");
  });

  return { currency, overallLimitCents, overallWeeklyLimitCents, budgets };
}

function cloneState(state: BudgetState): BudgetState {
  return {
    currency: state.currency,
    overallLimitCents: state.overallLimitCents,
    overallWeeklyLimitCents: state.overallWeeklyLimitCents,
    budgets: state.budgets.map((budget) => ({ ...budget })),
  };
}
