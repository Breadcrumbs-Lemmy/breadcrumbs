/**
 * Reason copy — implements docs/ui-copy-map.md "Reason Codes".
 *
 * Per CD-006 the UI owns every user-facing string. Backend `facts[]` and
 * `headlineFact` are diagnostic and are never rendered.
 *
 * Every template reads named fields from ReasonParameterMap. Nothing here
 * performs arithmetic on backend values — no subtraction, no comparison that
 * produces a displayed figure. Where a difference is shown, the backend
 * supplies it pre-computed (for example bufferShortfallCents).
 *
 * The COPY record is exhaustive over ReasonCode. Adding a backend reason code
 * without adding copy here is a compile error, by design.
 */
import type { DecisionReason, ReasonCode, ReasonParameterMap } from "@ai-fin-os/core";
import { formatMoney } from "../format/money";
import { formatDate } from "../format/dates";

export type ReasonCopy = {
  /** Shown when this is the determining reason. */
  primary: string;
  /** Shown in the collapsed list. */
  secondary: string;
  /** Present only on UNKNOWN codes; routes to the input that resolves it. */
  resolution?: { label: string; target: "accounts" | "purchase" | "obligations" };
};

type Composer<Code extends ReasonCode> = (
  parameters: ReasonParameterMap[Code],
  context: ReasonContext,
) => ReasonCopy;

export type ReasonContext = {
  /** Resolves entity ids to their user-visible labels. A lookup, not a calculation. */
  labelFor: (entityId: string) => string;
  relatedEntityIds: string[];
  referenceDate: string;
  horizonEndDate: string;
};

const money = formatMoney;
const day = (iso: string | undefined, ctx: ReasonContext) => formatDate(iso, ctx.referenceDate);

function firstLabel(ctx: ReasonContext, fallback: string): string {
  const id = ctx.relatedEntityIds[0];
  return id ? ctx.labelFor(id) : fallback;
}

/** True when the backend named a specific entity we can resolve to a label. */
function hasNamedEntity(ctx: ReasonContext): boolean {
  const id = ctx.relatedEntityIds[0];
  return id !== undefined && ctx.labelFor(id) !== "an item";
}

function labelList(ctx: ReasonContext, fallback: string): string {
  if (ctx.relatedEntityIds.length === 0) return fallback;
  const labels = ctx.relatedEntityIds.map(ctx.labelFor);
  if (labels.length === 1) return labels[0]!;
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

/** "your next paycheck on Aug 16" when known, else "your next paycheck". */
function incomeMoment(
  parameters: { nextReliableIncomeDate?: string },
  ctx: ReasonContext,
): string {
  return parameters.nextReliableIncomeDate
    ? `your next paycheck on ${day(parameters.nextReliableIncomeDate, ctx)}`
    : "your next paycheck";
}

const COPY: { [Code in ReasonCode]: Composer<Code> } = {
  // ---- AFFORDABLE -------------------------------------------------------
  BUFFER_PASSED: (p, ctx) => ({
    primary: `Projected cash stays at or above your ${money(p.minimumCashBufferCents)} buffer, with ${money(p.requiredBufferMarginCents)} to spare on ${day(p.minimumBalanceDate, ctx)}.`,
    secondary: `Stays above your ${money(p.minimumCashBufferCents)} buffer`,
  }),

  TIMING_RESERVE_PASSED: (p, ctx) => ({
    primary: `Bills due before ${incomeMoment(p, ctx)} are covered, leaving ${money(p.timingReserveMarginCents)} above your buffer.`,
    secondary: `Bills before ${incomeMoment(p, ctx)} are covered`,
  }),

  // ---- TIGHT ------------------------------------------------------------
  BUFFER_BELOW_MINIMUM: (p, ctx) => ({
    primary: `Projected cash drops to ${money(p.minimumBalanceCents)} on ${day(p.minimumBalanceDate, ctx)}. That's ${money(p.bufferShortfallCents)} below your ${money(p.minimumCashBufferCents)} buffer, but stays above zero.`,
    secondary: `${money(p.bufferShortfallCents)} below your buffer on ${day(p.minimumBalanceDate, ctx)}`,
  }),

  // timingReserveMarginCents is measured against the buffer, so it is negative
  // whenever the reserve is short of it. Printing it raw reads as "that leaves
  // -$150", which is wrong: cash is positive, it is the margin that is under.
  // Displayed as a distance below the buffer instead.
  TIMING_RESERVE_LOW: (p, ctx) => ({
    primary: `After this purchase, ${money(p.postPurchaseCashCents)} needs to cover ${money(p.timingReserveCents)} of bills before ${incomeMoment(p, ctx)}. That's ${money(Math.abs(p.timingReserveMarginCents))} below your ${money(p.minimumCashBufferCents)} buffer.`,
    secondary: `${money(Math.abs(p.timingReserveMarginCents))} below your buffer before ${incomeMoment(p, ctx)}`,
  }),

  OPTIONAL_OBLIGATION_TRADEOFF: (p, ctx) => ({
    primary: `Required bills are covered. The tight point on ${day(p.allEventsMinimumBalanceDate, ctx)} comes from optional and flexible items: ${labelList(ctx, "several optional items")}.`,
    secondary: `Optional items create the tight point`,
  }),

  GOAL_BUFFER_CONFLICT: (p, ctx) => {
    // Framing matters: the goal *can* still be funded. The user is never told
    // to skip it (D-006).
    const subject = hasNamedEntity(ctx) ? firstLabel(ctx, "") : "Your goal contribution";
    return {
      primary: `${subject} can still be funded. Doing so brings projected cash to ${money(p.protectedMinimumBalanceCents)} on ${day(p.protectedMinimumBalanceDate, ctx)}, below your ${money(p.minimumCashBufferCents)} buffer.`,
      secondary: `${subject} drops cash below your buffer`,
    };
  },

  BASELINE_ALREADY_TIGHT: (p, ctx) => ({
    primary: `Your forecast was already below your ${money(p.minimumCashBufferCents)} buffer before this purchase, reaching ${money(p.baselineMinimumBalanceCents)} on ${day(p.baselineMinimumBalanceDate, ctx)}. This purchase lowers that low point by ${money(p.purchaseImpactOnMinimumCents)}.`,
    secondary: `Forecast was already tight before this purchase`,
  }),

  // ---- RISKY ------------------------------------------------------------
  REQUIRED_OBLIGATION_SHORTFALL: (p, ctx) => ({
    primary: `Projected cash reaches ${money(p.requiredMinimumBalanceCents)} on ${day(p.requiredMinimumBalanceDate, ctx)}. Required bills aren't covered on the current schedule.`,
    secondary: `Required bills uncovered on ${day(p.requiredMinimumBalanceDate, ctx)}`,
  }),

  TIMING_RESERVE_SHORTFALL: (p, ctx) => ({
    primary: `After this purchase, ${money(p.postPurchaseCashCents)} doesn't cover ${money(p.timingReserveCents)} of bills due before ${incomeMoment(p, ctx)}.`,
    secondary: `Bills before ${incomeMoment(p, ctx)} aren't covered`,
  }),

  HIGH_PRIORITY_GOAL_SHORTFALL: (p, ctx) => {
    const on = day(p.protectedMinimumBalanceDate, ctx);
    // Avoids "A protected goal is set as protected" when no entity is named.
    return hasNamedEntity(ctx)
      ? {
          primary: `${firstLabel(ctx, "")} is set as protected. Funding it would require more cash than is projected to be available on ${on}.`,
          secondary: `${firstLabel(ctx, "")} can't be funded as scheduled`,
        }
      : {
          primary: `A protected goal contribution would require more cash than is projected to be available on ${on}.`,
          secondary: `A protected goal can't be funded as scheduled`,
        };
  },

  VARIABLE_INCOME_NOT_GUARANTEED: (p, ctx) => ({
    primary: `This works only if ${labelList(ctx, "expected income")} arrives in full. Counting only guaranteed income, projected cash reaches ${money(p.requiredMinimumBalanceCents)} on ${day(p.requiredMinimumBalanceDate, ctx)}.`,
    secondary: `Depends on ${labelList(ctx, "income")} that isn't guaranteed`,
  }),

  // ---- UNKNOWN ----------------------------------------------------------
  STALE_BALANCE: (p, ctx) => {
    const which =
      p.staleAccountIds.length > 0
        ? p.staleAccountIds.map(ctx.labelFor).join(", ")
        : "One of your accounts";
    return {
      primary: `${which} hasn't been updated recently enough. Balances this old can't produce a reliable projection.`,
      secondary: `${which} is out of date`,
      resolution: { label: "Update this balance", target: "accounts" },
    };
  },

  MISSING_PURCHASE_FIELD: (p) => {
    const names = p.missingFields.map((field) =>
      field === "amountCents" ? "an amount" : field === "purchaseDate" ? "a date" : "details",
    );
    const list =
      names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    return {
      primary: `This purchase is missing ${list}. Both an amount and a date are needed to project its effect.`,
      secondary: `Purchase is missing ${list}`,
      resolution: { label: "Add the missing details", target: "purchase" },
    };
  },

  COVERAGE_INCOMPLETE: (p, ctx) => {
    const through = day(p.horizonEndDate ?? ctx.horizonEndDate, ctx);
    const subject =
      p.coverageType === "income"
        ? "income"
        : p.coverageType === "obligations"
          ? "bills"
          : p.coverageType === "balances"
            ? "account balances"
            : p.coverageType === "currency"
              ? "currency information"
              : "some information";
    // The resolution must route to whatever is actually incomplete. A previous
    // version hard-coded "Confirm your recurring bills" for every coverage type,
    // so an income-coverage gap told the user to check their bills. The body
    // copy said "income" while the action said "bills" — visible nonsense that
    // only surfaced once a COVERAGE_INCOMPLETE fixture existed (H-010).
    const resolution =
      p.coverageType === "income"
        ? { label: "Confirm your income", target: "obligations" as const }
        : p.coverageType === "balances"
          ? { label: "Check your accounts", target: "accounts" as const }
          : { label: "Confirm your recurring bills", target: "obligations" as const };
    return {
      primary: `Not all ${subject} through ${through} has been confirmed. Answering now would overstate how much is known.`,
      secondary: `${subject.charAt(0).toUpperCase()}${subject.slice(1)} isn't confirmed through ${through}`,
      resolution,
    };
  },
};

/**
 * Composes user-facing copy for a reason. The DecisionReason discriminated
 * union narrows `parameters` to the matching entry in ReasonParameterMap, so
 * this dispatch is type-safe without a cast at the call site.
 */
export function reasonCopy(reason: DecisionReason, context: ReasonContext): ReasonCopy {
  const composer = COPY[reason.code] as Composer<typeof reason.code>;
  return composer(reason.parameters, { ...context, relatedEntityIds: reason.relatedEntityIds });
}
