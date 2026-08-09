/**
 * Screen 1: Setup — docs/ui-mvp0-screens.md.
 *
 * Builds and edits the `FinancialSnapshot`. Input shaping only: this screen
 * never evaluates coverage, freshness, or affordability. It records what the
 * user declares and lets backend validation decide whether the data is usable.
 */
import type { FinancialSnapshot } from "@ai-fin-os/core";
import { Card, Money, FreshnessDot } from "../components/primitives";
import { formatDate } from "../format/dates";
import { centsToDollars, dollarsToCents } from "../model/snapshot";
import { BOUNDARY_COPY } from "../copy";

type Props = {
  snapshot: FinancialSnapshot;
  onChange: (snapshot: FinancialSnapshot) => void;
};

export function SetupScreen({ snapshot, onChange }: Props) {
  const update = (mutate: (next: FinancialSnapshot) => void) => {
    const next = structuredClone(snapshot);
    mutate(next);
    onChange(next);
  };

  const spendable = snapshot.accounts.filter(
    (a) => a.includeInForecast && (a.role === "spendable_cash" || a.role === "reserve_cash"),
  );
  const credit = snapshot.accounts.filter((a) => a.role === "liability");

  return (
    <div className="w-full max-w-[720px] space-y-4">
      <Card title="Accounts">
        {snapshot.accounts.length === 0 ? (
          <p className="text-body text-ink-secondary">Add an account to get started.</p>
        ) : (
          <ul className="divide-y divide-line-subtle">
            {spendable.map((account) => (
              <li key={account.id} className="flex items-center justify-between gap-4 py-3">
                <span>
                  <span className="block text-body">{account.displayName}</span>
                  <FreshnessDot freshness={account.freshness} />
                </span>
                <span className="flex items-center gap-2">
                  <span className="text-ink-tertiary">$</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    aria-label={`${account.displayName} balance`}
                    defaultValue={centsToDollars(
                      account.availableBalanceCents ?? account.currentBalanceCents,
                    )}
                    onBlur={(e) => {
                      const cents = dollarsToCents(e.target.value);
                      if (cents === undefined) return;
                      update((next) => {
                        const target = next.accounts.find((a) => a.id === account.id);
                        if (!target) return;
                        target.currentBalanceCents = cents;
                        if (target.availableBalanceCents !== undefined) {
                          target.availableBalanceCents = cents;
                        }
                      });
                    }}
                    className="tabular w-32 rounded-md border border-line-strong bg-surface-raised px-2 py-1.5 text-right text-body outline-none focus:border-accent"
                  />
                </span>
              </li>
            ))}
          </ul>
        )}

        {credit.length > 0 && (
          <p className="mt-4 rounded-md bg-surface-sunken px-3 py-2 text-meta text-ink-secondary">
            Credit accounts are listed but not counted as spendable cash.
          </p>
        )}

        <p className="mt-4 text-meta text-ink-tertiary">{BOUNDARY_COPY.NO_ACCOUNT_WRITES}</p>
      </Card>

      <Card title="Income">
        <ReadOnlyList
          items={snapshot.incomeSources.map((income) => ({
            id: income.id,
            label: income.label,
            detail: `${cadenceLabel(income.cadence.kind)} · next ${formatDate(income.nextExpectedDate, snapshot.asOfDate)}`,
            cents: income.expectedAmountCents,
          }))}
          empty="No income added yet."
        />
      </Card>

      <Card title="Recurring bills">
        {(["required", "flexible", "optional"] as const).map((importance) => {
          const group = snapshot.recurringObligations.filter((o) => o.importance === importance);
          if (group.length === 0) return null;
          return (
            <div key={importance} className="mb-4 last:mb-0">
              <h3 className="mb-1 text-label capitalize text-ink-secondary">{importance}</h3>
              <ReadOnlyList
                items={group.map((obligation) => ({
                  id: obligation.id,
                  label: obligation.label,
                  detail: `${cadenceLabel(obligation.cadence.kind)} · next ${formatDate(obligation.nextDueDate, snapshot.asOfDate)}`,
                  cents: obligation.amountCents,
                }))}
                empty=""
              />
            </div>
          );
        })}
        {snapshot.recurringObligations.length === 0 && (
          <p className="text-body text-ink-secondary">No bills added yet.</p>
        )}
      </Card>

      <Card title="Goals">
        <ReadOnlyList
          items={snapshot.goals.map((goal) => ({
            id: goal.id,
            label: `${goal.label}${goal.protection === "protected" ? " · protected" : ""}`,
            detail: `${goal.priority} priority · next ${formatDate(goal.nextContributionDate, snapshot.asOfDate)}`,
            cents: goal.monthlyContributionCents,
          }))}
          empty="No goals added yet."
        />
      </Card>

      {/* The coverage section determines whether the engine will answer at all.
          If it is buried, users produce UNKNOWN results they cannot explain. */}
      <Card title="What's complete">
        <p className="mb-4 text-body text-ink-secondary">
          These confirmations let the projection tell you when it doesn't know something, instead of
          guessing.
        </p>

        <Checkbox
          checked={snapshot.coverage.balancesDeclaredComplete}
          onChange={(value) =>
            update((next) => {
              next.coverage.balancesDeclaredComplete = value;
            })
          }
          label="I've added all my spending accounts"
        />
        <Checkbox
          checked={snapshot.coverage.userConfirmedNoOtherRequiredObligations}
          onChange={(value) =>
            update((next) => {
              next.coverage.userConfirmedNoOtherRequiredObligations = value;
            })
          }
          label="Nothing else is due that I haven't listed"
        />

        <div className="mt-4 space-y-3 border-t border-line-subtle pt-4">
          <DateDeclaration
            label="I've added all my bills through"
            value={snapshot.coverage.obligationsDeclaredCompleteThroughDate}
            onChange={(value) =>
              update((next) => {
                next.coverage.obligationsDeclaredCompleteThroughDate = value;
              })
            }
          />
          <DateDeclaration
            label="I've added all income through"
            value={snapshot.coverage.incomeDeclaredCompleteThroughDate}
            onChange={(value) =>
              update((next) => {
                next.coverage.incomeDeclaredCompleteThroughDate = value;
              })
            }
          />
        </div>
      </Card>

      <Card title="Assumptions">
        <div className="flex items-baseline justify-between gap-4">
          <span className="text-label text-ink-secondary">Cash buffer</span>
          <Money cents={snapshot.config.minimumCashBufferCents} />
        </div>
        {/* CD-008: visible because it drives most TIGHT verdicts, but not
            editable in MVP 0. */}
        <p className="mt-2 text-meta text-ink-tertiary">
          The amount kept aside before a purchase counts as comfortable. Fixed in this version.
        </p>
      </Card>
    </div>
  );
}

function ReadOnlyList({
  items,
  empty,
}: {
  items: { id: string; label: string; detail: string; cents: number }[];
  empty: string;
}) {
  if (items.length === 0) {
    return empty ? <p className="text-body text-ink-secondary">{empty}</p> : null;
  }
  return (
    <ul className="divide-y divide-line-subtle">
      {items.map((item) => (
        <li key={item.id} className="flex items-baseline justify-between gap-4 py-2">
          <span>
            <span className="block text-body">{item.label}</span>
            <span className="text-meta text-ink-tertiary">{item.detail}</span>
          </span>
          <Money cents={item.cents} />
        </li>
      ))}
    </ul>
  );
}

function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex min-h-[44px] items-center gap-2.5 text-body">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4"
      />
      {label}
    </label>
  );
}

function DateDeclaration({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-body">
      <span className="text-ink-secondary">{label}</span>
      <input
        type="date"
        value={value}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        className="tabular rounded-md border border-line-strong bg-surface-raised px-2 py-1.5 text-body outline-none focus:border-accent"
      />
    </div>
  );
}

function cadenceLabel(kind: string): string {
  const labels: Record<string, string> = {
    once: "One time",
    weekly: "Weekly",
    biweekly: "Every 2 weeks",
    semimonthly: "Twice a month",
    monthly: "Monthly",
    quarterly: "Quarterly",
    annual: "Yearly",
  };
  return labels[kind] ?? kind;
}
