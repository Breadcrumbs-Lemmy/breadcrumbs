/**
 * Spending insights — the waste-detection surface.
 *
 * The user's words: "the things I am spending on that I am not paying attention
 * to". Subscriptions are the waste people already know about. **Frequent small
 * purchases are the kind that surprises you** — eleven separate $6 charges are
 * invisible on a statement and obvious in a list. That detector is the reason
 * this module exists.
 *
 * Every insight is deterministic and carries the transaction ids that produced
 * it, so a user can verify any claim. An insight the user cannot check is an
 * assertion, not a fact.
 *
 * Tone is bound by `D-006`: state amounts, counts, and options. Never judge.
 * Savings are always a range with a stated basis, because a single figure edges
 * from observation into recommendation, which `D-002` bars.
 */
import type { Account, Transaction } from "./types";
import {
  containsDate,
  periodForDate,
  periodFromKey,
  recentPeriods,
  type Period,
  type PeriodKind,
} from "./periods";

export type InsightType =
  | "FREQUENT_SMALL_PURCHASES"
  | "POSSIBLE_DUPLICATE_SERVICE"
  | "RISING_CATEGORY"
  | "LIKELY_SUBSCRIPTION";

export type InsightConfidence = "low" | "medium" | "high";

export type InsightMerchant = {
  normalizedMerchantId: string;
  displayName: string;
  count: number;
  totalCents: number;
};

export type Insight = {
  id: string;
  type: InsightType;
  /** Backend-supplied display copy. See the note in `docs/ui-api-contract.md`
   *  — this is a deliberate, flagged exception to `CD-006`. */
  headline: string;
  detail: string;
  totalCents: number;
  occurrenceCount?: number;
  averageCents?: number;
  category?: string;
  categoryDisplayName?: string;
  merchants?: InsightMerchant[];
  members?: { normalizedMerchantId: string; displayName: string; amountCents: number }[];
  cadence?: string;
  comparison?: { direction: "up" | "down"; changeCents: number };
  potentialSavings?: { lowCents: number; highCents: number; basis: string };
  confidence: InsightConfidence;
  transactionIds: string[];
};

export type RecurringItem = {
  normalizedMerchantId: string;
  displayName: string;
  amountCents: number;
  cadence: string;
  cadenceLabel: string;
  nextExpectedDate?: string;
  lastChargedDate: string;
  category: string;
  confidence: InsightConfidence;
};

export type InsightsResult = {
  period: Period;
  insights: Insight[];
  recurring: {
    totalMonthlyCents: number;
    count: number;
    items: RecurringItem[];
  };
};

export type InsightsOptions = {
  transactions: Transaction[];
  accounts: Account[];
  currency: string;
  asOfDate: string;
  kind: Exclude<PeriodKind, "statement">;
  key?: string;
  categoryLabel?: (id: string) => string;
  config?: Partial<InsightsConfig>;
};

export type InsightsConfig = {
  /** Below this, a purchase counts as "small". */
  smallPurchaseCeilingCents: number;
  /** Occurrences in the period before it is worth mentioning. */
  frequentMinimumCount: number;
  /** Total below which a frequent-purchase group is not worth surfacing. */
  frequentMinimumTotalCents: number;
  /** Minimum absolute rise before a category is called rising. */
  risingMinimumChangeCents: number;
  /** Minimum relative rise, in basis points. */
  risingMinimumBasisPoints: number;
  /** Members before a duplicate-service group is reported. */
  duplicateMinimumMembers: number;
};

export const DEFAULT_INSIGHTS_CONFIG: InsightsConfig = {
  // Thresholds chosen so the surface stays quiet. An insights screen that
  // fires on everything trains the user to ignore it.
  smallPurchaseCeilingCents: 2500,
  frequentMinimumCount: 5,
  frequentMinimumTotalCents: 3000,
  risingMinimumChangeCents: 5000,
  risingMinimumBasisPoints: 2500,
  duplicateMinimumMembers: 2,
};

/** Categories whose members plausibly substitute for one another. */
const SUBSTITUTABLE_CATEGORIES = new Set(["streaming", "music_audio", "cloud_storage", "software"]);

const CADENCE_LABELS: Record<string, string> = {
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  monthly: "Monthly",
  quarterly: "Quarterly",
  annual: "Yearly",
};

function money(cents: number): string {
  const n = Math.abs(cents) / 100;
  // Whole dollars render without decimals; anything with cents shows exactly two.
  // Setting only `maximumFractionDigits` dropped a trailing zero, so $10.50
  // rendered as "$10.5" — wrong in money copy the user reads verbatim.
  const fraction = n % 1 === 0 ? 0 : 2;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: fraction, maximumFractionDigits: fraction })}`;
}

function isSpend(t: Transaction): boolean {
  return t.flowType === "SPEND" || t.flowType === "FEE";
}

function merchantKey(t: Transaction): string {
  return t.normalizedMerchantId ?? t.merchantName.toLowerCase().replace(/\s+/g, "_");
}

export function detectInsights(options: InsightsOptions): InsightsResult {
  const {
    transactions,
    currency,
    asOfDate,
    kind,
    key,
    categoryLabel = (id) => id,
  } = options;
  const config = { ...DEFAULT_INSIGHTS_CONFIG, ...options.config };

  const period = key
    ? periodFromKeyOrNow(kind, key, asOfDate)
    : periodForDate(kind, asOfDate, asOfDate);

  const scoped = transactions.filter((t) => t.currency === currency);
  const inPeriod = scoped.filter((t) => containsDate(period, t.postedDate) && isSpend(t));

  const insights: Insight[] = [
    ...frequentSmallPurchases(inPeriod, period, config, categoryLabel, scoped, kind),
    ...duplicateServices(inPeriod, config, categoryLabel),
    ...risingCategories(inPeriod, scoped, period, kind, config, categoryLabel),
  ];

  // Largest first: the biggest number is the one worth acting on.
  insights.sort((a, b) => b.totalCents - a.totalCents);

  return { period, insights, recurring: recurringSummary(inPeriod, categoryLabel) };
}

/**
 * Resolves a requested period key, falling back to the period containing
 * `asOfDate` when the key is unparseable.
 *
 * `periodFromKey` is shared with `summarizeSpending` on purpose. A local key
 * parser here previously understood `2026-08` and `2026` but not `2026-W32`,
 * so a requested week silently resolved to the current one — the insights
 * screen showed a different week's findings than the totals beside it, with no
 * error to reveal the mismatch.
 */
function periodFromKeyOrNow(
  kind: Exclude<PeriodKind, "statement">,
  key: string,
  asOfDate: string,
): Period {
  return periodFromKey(kind, key, asOfDate) ?? periodForDate(kind, asOfDate, asOfDate);
}

/**
 * Frequent small purchases.
 *
 * The detector the product exists for. Groups small spends by category, and
 * reports when the count clears a threshold — because the total is a surprise
 * precisely when no single charge was.
 */
function frequentSmallPurchases(
  inPeriod: Transaction[],
  period: Period,
  config: InsightsConfig,
  categoryLabel: (id: string) => string,
  allScoped: Transaction[],
  kind: Exclude<PeriodKind, "statement">,
): Insight[] {
  const byCategory = new Map<string, Transaction[]>();
  for (const t of inPeriod) {
    if (Math.abs(t.amountCents) > config.smallPurchaseCeilingCents) continue;
    const list = byCategory.get(t.category) ?? [];
    list.push(t);
    byCategory.set(t.category, list);
  }

  const out: Insight[] = [];
  for (const [category, items] of byCategory) {
    const total = items.reduce((sum, t) => sum + Math.abs(t.amountCents), 0);
    if (items.length < config.frequentMinimumCount) continue;
    if (total < config.frequentMinimumTotalCents) continue;

    const merchants = new Map<string, InsightMerchant>();
    for (const t of items) {
      const id = merchantKey(t);
      const m =
        merchants.get(id) ??
        ({ normalizedMerchantId: id, displayName: t.merchantName, count: 0, totalCents: 0 });
      m.count += 1;
      m.totalCents += Math.abs(t.amountCents);
      merchants.set(id, m);
    }
    const ranked = [...merchants.values()].sort((a, b) => b.totalCents - a.totalCents);
    const label = categoryLabel(category);
    const average = Math.round(total / items.length);

    const prior = priorPeriodTotal(allScoped, period, kind, (t) =>
      t.category === category && Math.abs(t.amountCents) <= config.smallPurchaseCeilingCents,
    );

    out.push({
      id: `insight_frequent_${category}`,
      type: "FREQUENT_SMALL_PURCHASES",
      headline: `${label}, ${items.length} times this ${period.kind}`,
      detail:
        ranked.length > 1
          ? `Small, frequent, and easy to miss on a statement. ${describeMerchants(ranked)}.`
          : `Small, frequent, and easy to miss on a statement. All at ${ranked[0]!.displayName}.`,
      totalCents: total,
      occurrenceCount: items.length,
      averageCents: average,
      category,
      categoryDisplayName: label,
      merchants: ranked,
      comparison:
        prior !== undefined && prior !== total
          ? { direction: total > prior ? "up" : "down", changeCents: Math.abs(total - prior) }
          : undefined,
      confidence: items.length >= config.frequentMinimumCount * 2 ? "high" : "medium",
      transactionIds: items.map((t) => t.id),
    });
  }
  return out;
}

function describeMerchants(ranked: InsightMerchant[]): string {
  const top = ranked.slice(0, 2).map((m) => `${m.displayName} ${m.count} times`);
  const rest = ranked.length - top.length;
  return rest > 0 ? `${top.join(", ")}, and ${rest} more` : top.join(", ");
}

/** Several concurrent services in a category that plausibly substitute. */
function duplicateServices(
  inPeriod: Transaction[],
  config: InsightsConfig,
  categoryLabel: (id: string) => string,
): Insight[] {
  const out: Insight[] = [];
  const byCategory = new Map<string, Map<string, { name: string; cents: number; ids: string[] }>>();

  for (const t of inPeriod) {
    if (!SUBSTITUTABLE_CATEGORIES.has(t.category)) continue;
    if (!t.recurrenceSignal?.isLikelyRecurring) continue;
    const cat = byCategory.get(t.category) ?? new Map();
    const id = merchantKey(t);
    const entry = cat.get(id) ?? { name: t.merchantName, cents: 0, ids: [] };
    entry.cents += Math.abs(t.amountCents);
    entry.ids.push(t.id);
    cat.set(id, entry);
    byCategory.set(t.category, cat);
  }

  for (const [category, merchants] of byCategory) {
    if (merchants.size < config.duplicateMinimumMembers + 1) continue;
    const members = [...merchants.entries()]
      .map(([id, m]) => ({ normalizedMerchantId: id, displayName: m.name, amountCents: m.cents }))
      .sort((a, b) => b.amountCents - a.amountCents);
    const total = members.reduce((s, m) => s + m.amountCents, 0);
    const amounts = members.map((m) => m.amountCents);
    const label = categoryLabel(category);

    out.push({
      id: `insight_duplicate_${category}`,
      type: "POSSIBLE_DUPLICATE_SERVICE",
      headline: `${members.length} ${label.toLowerCase()} services`,
      detail: `${members.map((m) => m.displayName).join(", ")} all bill regularly. They may overlap.`,
      totalCents: total,
      cadence: "monthly",
      category,
      categoryDisplayName: label,
      members,
      // A range, never a single figure. "You could save $17.99" is advice;
      // "dropping one would free $13.99–$17.99" is arithmetic the user can check.
      potentialSavings: {
        lowCents: Math.min(...amounts),
        highCents: Math.max(...amounts),
        basis: "cheapest_to_costliest_member",
      },
      confidence: members.length >= 3 ? "medium" : "low",
      transactionIds: [...merchants.values()].flatMap((m) => m.ids),
    });
  }
  return out;
}

function risingCategories(
  inPeriod: Transaction[],
  allScoped: Transaction[],
  period: Period,
  kind: Exclude<PeriodKind, "statement">,
  config: InsightsConfig,
  categoryLabel: (id: string) => string,
): Insight[] {
  // A partial period always looks lower than a complete one. Comparing them
  // would produce a reassuring fall that is purely an artefact of the calendar.
  if (period.partial) return [];

  const totals = new Map<string, { cents: number; ids: string[] }>();
  for (const t of inPeriod) {
    const e = totals.get(t.category) ?? { cents: 0, ids: [] };
    e.cents += Math.abs(t.amountCents);
    e.ids.push(t.id);
    totals.set(t.category, e);
  }

  const out: Insight[] = [];
  for (const [category, current] of totals) {
    const prior = priorPeriodTotal(allScoped, period, kind, (t) => t.category === category);
    if (prior === undefined || prior === 0) continue;

    const change = current.cents - prior;
    if (change < config.risingMinimumChangeCents) continue;
    const bp = Math.round((change / prior) * 10000);
    if (bp < config.risingMinimumBasisPoints) continue;

    const label = categoryLabel(category);
    out.push({
      id: `insight_rising_${category}`,
      type: "RISING_CATEGORY",
      headline: `${label} up sharply`,
      detail: `${money(current.cents)} this ${period.kind}, against ${money(prior)} before.`,
      totalCents: current.cents,
      category,
      categoryDisplayName: label,
      comparison: { direction: "up", changeCents: change },
      confidence: "high",
      transactionIds: current.ids,
    });
  }
  return out;
}

function priorPeriodTotal(
  scoped: Transaction[],
  period: Period,
  kind: Exclude<PeriodKind, "statement">,
  predicate: (t: Transaction) => boolean,
): number | undefined {
  const window = recentPeriods(kind, period.startDate, 2);
  const previous = window.find((p) => p.key !== period.key);
  if (!previous) return undefined;
  const items = scoped.filter(
    (t) => containsDate(previous, t.postedDate) && isSpend(t) && predicate(t),
  );
  if (items.length === 0) return undefined;
  return items.reduce((s, t) => s + Math.abs(t.amountCents), 0);
}

function recurringSummary(
  inPeriod: Transaction[],
  categoryLabel: (id: string) => string,
): InsightsResult["recurring"] {
  const byMerchant = new Map<string, RecurringItem>();
  for (const t of inPeriod) {
    if (!t.recurrenceSignal?.isLikelyRecurring) continue;
    const id = merchantKey(t);
    const cadence = t.recurrenceSignal.cadence ?? "monthly";
    const confidence: InsightConfidence =
      t.recurrenceSignal.confidence >= 0.85
        ? "high"
        : t.recurrenceSignal.confidence >= 0.6
          ? "medium"
          : "low";
    const existing = byMerchant.get(id);
    if (!existing || t.postedDate > existing.lastChargedDate) {
      byMerchant.set(id, {
        normalizedMerchantId: id,
        displayName: t.merchantName,
        amountCents: Math.abs(t.amountCents),
        cadence,
        cadenceLabel: CADENCE_LABELS[cadence] ?? cadence,
        lastChargedDate: t.postedDate,
        category: categoryLabel(t.category),
        confidence,
      });
    }
  }
  const items = [...byMerchant.values()].sort((a, b) => b.amountCents - a.amountCents);
  return {
    totalMonthlyCents: items.reduce((s, i) => s + i.amountCents, 0),
    count: items.length,
    items,
  };
}
