import { GoalSchema } from "@ai-fin-os/core";
import type { Goal } from "@ai-fin-os/core";
import { homedir } from "node:os";
import { join } from "node:path";

import { FieldCipher } from "../crypto/field-cipher";
import { readJsonFile, writeJsonFileAtomic } from "../persistence/atomic-file";

/** Same envelope shape as the statement store: an encrypted goals file is
 *  `{ "$enc": "bcenc1:…" }`, a legacy/plaintext file is the bare state. */
type EncryptedStateEnvelope = { $enc: string };

/** Domain-separation label bound as GCM additional data, distinct from every
 *  other store's, so a goals blob can never be decrypted as some other kind of
 *  encrypted field. */
const GOAL_STATE_AAD = "goal-state";

const DEFAULT_CURRENCY = "USD";

/**
 * A user's declared savings goals. This is *intent*, not history —
 * a goal is a target the user set (nothing in a statement observes it, `D-G2`).
 * The store holds the canonical `Goal` shape the affordability engine consumes,
 * already shaped from the user's reduced input by core `buildSavingsGoal`;
 * progress and pace are computed on the fly. Small and whole-set: the UI edits it
 * as one object, so the store replaces it as one.
 */
export type GoalState = {
  currency: string;
  goals: Goal[];
};

export interface GoalStore {
  load(): Promise<GoalState>;
  save(state: GoalState): Promise<GoalState>;
}

const EMPTY_STATE: GoalState = {
  currency: DEFAULT_CURRENCY,
  goals: [],
};

export class InMemoryGoalStore implements GoalStore {
  private state: GoalState;

  constructor(initialState: GoalState = EMPTY_STATE) {
    this.state = normalizeState(initialState);
  }

  async load(): Promise<GoalState> {
    return cloneState(this.state);
  }

  async save(state: GoalState): Promise<GoalState> {
    this.state = normalizeState(state);
    return cloneState(this.state);
  }
}

export class FileGoalStore implements GoalStore {
  /** Serialises writes so two near-simultaneous saves (two tabs editing goals)
   *  cannot interleave and drop one. Same guard the statement store uses. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath = defaultGoalStorePath(),
    /** When set, the whole goals blob is encrypted at rest — a savings goal
     *  reveals financial intent (what a user is planning for), so it gets the
     *  same envelope as transactions. Absent = plaintext behind file
     *  permissions. */
    private readonly cipher?: FieldCipher,
  ) {}

  async load(): Promise<GoalState> {
    const raw = await readJsonFile<Partial<GoalState> & Partial<EncryptedStateEnvelope>>(this.filePath, {});
    if (raw && typeof raw === "object" && typeof (raw as EncryptedStateEnvelope).$enc === "string") {
      // Encrypted on disk. Without a key we must not silently return an empty set
      // and let the next save overwrite the user's real goals — fail loud.
      if (!this.cipher) {
        throw new Error(
          "Goal store is encrypted but no encryption key is configured (BREADCRUMBZ_ENCRYPTION_KEY).",
        );
      }
      const plaintext = this.cipher.decrypt((raw as EncryptedStateEnvelope).$enc, GOAL_STATE_AAD);
      return normalizeState(JSON.parse(plaintext) as Partial<GoalState>);
    }
    // No `$enc`: legacy plaintext (or empty). Readable with or without a cipher;
    // a configured cipher re-seals it on the next save.
    return normalizeState(raw as Partial<GoalState>);
  }

  save(state: GoalState): Promise<GoalState> {
    const next = this.queue.then(async () => {
      const normalized = normalizeState(state);
      await this.persist(normalized);
      return normalized;
    });
    // Keep the chain alive even if one write throws, so a single failure does not
    // wedge every later save behind a rejected promise.
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Crash-safe (temp-write-then-rename) and mode 0600 either way — see
   *  persistence/atomic-file — and encrypted when a cipher is configured. */
  private async persist(state: GoalState): Promise<void> {
    const payload: GoalState | EncryptedStateEnvelope = this.cipher
      ? { $enc: this.cipher.encrypt(JSON.stringify(state), GOAL_STATE_AAD) }
      : state;
    await writeJsonFileAtomic(this.filePath, payload);
  }
}

export function defaultGoalStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.BREADCRUMBZ_LOCAL_DATA_DIR?.trim();
  const dataDir = configured && configured.length > 0 ? configured : join(homedir(), ".breadcrumbz", "local-data");
  return join(dataDir, "goals.json");
}

/**
 * Coerce whatever is on disk (or injected) into a valid state. Defensive so a
 * hand-edited or partially-written file never crashes a read: each goal is
 * validated against the canonical `GoalSchema` and dropped whole if malformed,
 * duplicate ids collapse to the first, and the set is sorted by id for a stable
 * order on disk and in responses. The route validates the reduced *input* on the
 * way in and shapes canonical goals; this is the belt to that suspenders.
 */
export function normalizeState(input: Partial<GoalState> | undefined | null): GoalState {
  const currency =
    typeof input?.currency === "string" && input.currency.length === 3
      ? input.currency.toUpperCase()
      : DEFAULT_CURRENCY;

  const goals: Goal[] = [];
  const seen = new Set<string>();
  if (Array.isArray(input?.goals)) {
    for (const candidate of input.goals) {
      const parsed = GoalSchema.safeParse(candidate);
      if (!parsed.success) continue;
      const goal = parsed.data as Goal;
      if (seen.has(goal.id)) continue;
      seen.add(goal.id);
      goals.push(goal);
    }
  }
  // Stable order on disk and in responses, independent of edit order. The screen
  // re-sorts worst-first for display; this just keeps the file deterministic.
  goals.sort((a, b) => a.id.localeCompare(b.id));

  return { currency, goals };
}

function cloneState(state: GoalState): GoalState {
  return {
    currency: state.currency,
    goals: state.goals.map((goal) => ({ ...goal })),
  };
}
