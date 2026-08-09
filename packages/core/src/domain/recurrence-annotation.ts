/**
 * Derives `Transaction.recurrenceSignal` from observed history.
 *
 * `recurrenceSignal` is an optional field on a transaction, and the consumers
 * that read it — the insights `recurring` block, the duplicate-service
 * detector, and `TransactionView.isRecurring` — treat its absence as "not
 * recurring". That is only correct if something writes it.
 *
 * Nothing did. Fixtures carried the field by hand, so tests passed, while every
 * CSV-imported and Plaid-imported transaction arrived without it. The result
 * was a subscriptions panel that read "0 subscriptions" over a dataset with
 * four monthly subscriptions in it — the detector existed and worked, it simply
 * was not connected to the data.
 *
 * This module closes that gap by running the existing deterministic detector
 * (`detectRecurringSpending`) and stamping its findings onto the transactions
 * it identified. It invents nothing: a transaction is marked recurring only
 * because that detector, with its own thresholds and confidence caps, named it.
 *
 * Ingest is the wrong place for this. Recurrence is a property of a *series*,
 * not of a row, so it cannot be known when a row is first read — the second and
 * third charges have not happened yet. It is therefore derived at read time,
 * from the whole history, every time.
 */
import { detectRecurringSpending } from "./pattern-detection";
import type { RecurringSpendingConfig } from "./pattern-detection";
import type { Account, Cadence, Transaction } from "./types";

/** The detector reports 0–100; `recurrenceSignal.confidence` is a 0–1 fraction. */
const CONFIDENCE_SCALE = 100;

export type AnnotateRecurrenceOptions = {
  transactions: Transaction[];
  accounts?: Account[];
  currency: string;
  /** Defaults to the latest posted date, so results stay deterministic. */
  analysisDate?: string;
  config?: Partial<RecurringSpendingConfig>;
};

/**
 * Returns a copy of `transactions` with `recurrenceSignal` set on every
 * transaction that belongs to a detected subscription series.
 *
 * Transactions that already carry an explicit signal keep it. A fixture or an
 * upstream provider that states recurrence outranks our inference of it.
 */
export function annotateRecurrenceSignals(options: AnnotateRecurrenceOptions): Transaction[] {
  const { transactions, accounts = [], currency, analysisDate, config } = options;

  const detection = detectRecurringSpending({
    transactions,
    accounts,
    currency,
    analysisDate,
    config,
  });

  const signalByTransactionId = new Map<string, Transaction["recurrenceSignal"]>();
  for (const insight of detection.insights) {
    if (insight.evidence.kind !== "likely_subscription") continue;
    const signal = {
      isLikelyRecurring: true,
      cadence: insight.evidence.cadence satisfies Cadence["kind"],
      confidence: insight.confidenceScore / CONFIDENCE_SCALE,
    };
    for (const id of insight.evidence.transactionIds) {
      const existing = signalByTransactionId.get(id);
      // A merchant can appear in more than one insight. Keep the strongest
      // evidence rather than whichever the loop reached last.
      if (!existing || existing.confidence < signal.confidence) {
        signalByTransactionId.set(id, signal);
      }
    }
  }

  if (signalByTransactionId.size === 0) return transactions;

  return transactions.map((transaction) => {
    if (transaction.recurrenceSignal) return transaction;
    const signal = signalByTransactionId.get(transaction.id);
    return signal ? { ...transaction, recurrenceSignal: signal } : transaction;
  });
}
