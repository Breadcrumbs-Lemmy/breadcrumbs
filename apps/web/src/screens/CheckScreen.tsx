/**
 * Screen 2: Purchase check — docs/ui-mvp0-screens.md.
 *
 * The product's central question. Deliberately sparse.
 *
 * There is no client-side affordability preview here, not even a "you have $X"
 * hint. Any such hint would be the UI answering the question the backend owns.
 */
import type { PurchaseDraft } from "../model/snapshot";
import { draftIsSubmittable } from "../model/snapshot";
import type { SnapshotNotes } from "../services/api";
import { formatMoney } from "../format/money";
import { UI_COPY } from "../copy";

type Props = {
  draft: PurchaseDraft;
  onChange: (draft: PurchaseDraft) => void;
  onSubmit: () => void;
  submitting: boolean;
  /** Named sections still missing from the snapshot, if any. */
  blockedBy?: { message: string; onFix: () => void };
  /** What the backend inferred from history to answer this. Shown because a
   *  derived paycheck is a guess with evidence behind it, and the person
   *  answering "can I afford this" should know which parts were guessed. */
  snapshotNotes?: SnapshotNotes | null;
  /** The derived bills, so the user can confirm the list rather than confirm
   *  a claim they have no way to check. */
  obligations?: { id: string; label: string; amountCents: number }[];
  /** Whether the user has affirmed there are no other required bills. The
   *  engine blocks on this (`COVERAGE_INCOMPLETE`) and nothing derived from a
   *  statement can set it — only a person knows what wasn't imported. */
  obligationsConfirmed?: boolean;
  onConfirmObligations?: (confirmed: boolean) => void;
  /** Opens the Goals screen. Savings goals feed into this verdict (a protected
   *  goal is treated as a commitment), so the two live next to each other. */
  onOpenGoals?: () => void;
};

const CATEGORIES = [
  "general",
  "office",
  "electronics",
  "home",
  "travel",
  "health",
  "food",
  "transport",
];

export function CheckScreen({
  draft,
  onChange,
  onSubmit,
  submitting,
  blockedBy,
  snapshotNotes,
  obligations,
  obligationsConfirmed,
  onConfirmObligations,
  onOpenGoals,
}: Props) {
  const ready = draftIsSubmittable(draft) && !blockedBy;
  const set = <K extends keyof PurchaseDraft>(key: K, value: PurchaseDraft[K]) =>
    onChange({ ...draft, [key]: value });

  return (
    <div className="mx-auto w-full max-w-[520px] py-4">
      <h1 className="text-center font-display text-hero leading-tight">Can I afford this?</h1>

      <form
        className="mt-8 space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !submitting) onSubmit();
        }}
      >
        <Field label={UI_COPY.amountLabel} htmlFor="amount">
          <div className="flex items-center rounded-md border border-line-strong bg-surface-raised focus-within:border-accent">
            <span className="pl-3 text-amount text-ink-tertiary">$</span>
            <input
              id="amount"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={draft.amount}
              onChange={(e) => set("amount", e.target.value)}
              placeholder="0"
              className="tabular w-full bg-transparent px-2 py-3 text-amount outline-none"
            />
          </div>
        </Field>

        <Field label={UI_COPY.dateLabel} htmlFor="date">
          <input
            id="date"
            type="date"
            value={draft.purchaseDate}
            onChange={(e) => set("purchaseDate", e.target.value)}
            className="tabular w-full rounded-md border border-line-strong bg-surface-raised px-3 py-3 text-body outline-none focus:border-accent"
          />
        </Field>

        <Field label={UI_COPY.categoryLabel} htmlFor="label">
          <input
            id="label"
            type="text"
            value={draft.label}
            onChange={(e) => set("label", e.target.value)}
            placeholder="New laptop"
            className="w-full rounded-md border border-line-strong bg-surface-raised px-3 py-3 text-body outline-none focus:border-accent"
          />
          <select
            aria-label="Category"
            value={draft.category}
            onChange={(e) => set("category", e.target.value)}
            className="mt-2 w-full rounded-md border border-line-strong bg-surface-raised px-3 py-2.5 text-body outline-none focus:border-accent"
          >
            {CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {category.charAt(0).toUpperCase() + category.slice(1)}
              </option>
            ))}
          </select>
        </Field>

        <fieldset className="border-0 p-0">
          <legend className="mb-2 text-label text-ink-secondary">How necessary is it?</legend>
          <div className="flex gap-2">
            {(["essential", "useful", "discretionary"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => set("necessity", option)}
                aria-pressed={draft.necessity === option}
                className={`min-h-[44px] flex-1 rounded-md border px-3 text-body capitalize ${
                  draft.necessity === option
                    ? "border-line-strong bg-surface-sunken text-ink"
                    : "border-line-subtle bg-surface-raised text-ink-secondary"
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="flex min-h-[44px] items-center gap-2.5 text-body">
          <input
            type="checkbox"
            checked={draft.deferrable}
            onChange={(e) => set("deferrable", e.target.checked)}
            className="h-4 w-4"
          />
          {UI_COPY.deferrableLabel}
        </label>

        {/* Never a bare disabled button: the reason is always stated. */}
        {blockedBy && (
          <p className="rounded-md border border-line-subtle bg-surface-sunken px-4 py-3 text-body text-ink-secondary">
            {blockedBy.message}{" "}
            <button type="button" onClick={blockedBy.onFix} className="text-accent underline underline-offset-4">
              Import one
            </button>
          </p>
        )}

        {!blockedBy && snapshotNotes && <DerivedFrom notes={snapshotNotes} />}

        {!blockedBy && obligations && obligations.length > 0 && onConfirmObligations && (
          <ConfirmObligations
            obligations={obligations}
            confirmed={Boolean(obligationsConfirmed)}
            onChange={onConfirmObligations}
          />
        )}

        <button
          type="submit"
          disabled={!ready || submitting}
          className="min-h-[52px] w-full rounded-md bg-ink px-4 text-body font-medium text-ink-inverse disabled:opacity-40"
        >
          {submitting ? UI_COPY.loading : UI_COPY.primaryAction}
        </button>

        <p className="text-center text-meta text-ink-tertiary">
          Necessity and timing are recorded with the purchase. They don't change the projection.
        </p>
      </form>

      {onOpenGoals && (
        <p className="mt-6 text-center text-meta text-ink-tertiary">
          Saving toward something?{" "}
          <button
            type="button"
            onClick={onOpenGoals}
            className="text-accent underline underline-offset-4 hover:text-accent-hover"
          >
            Set a savings goal
          </button>{" "}
          — a protected goal is weighed as a commitment here.
        </p>
      )}
    </div>
  );
}

/**
 * What the projection is built from.
 *
 * The engine derives income and bills from repeating transactions, which is a
 * far better input than a fixture and still an inference. Saying so is not a
 * disclaimer — it tells the user which part of a `TIGHT` verdict to go check.
 */
function DerivedFrom({ notes }: { notes: SnapshotNotes }) {
  const parts: string[] = [];
  if (notes.incomeSourceCount > 0) {
    parts.push(`${notes.incomeSourceCount} income source${notes.incomeSourceCount === 1 ? "" : "s"}`);
  }
  if (notes.recurringObligationCount > 0) {
    parts.push(
      `${notes.recurringObligationCount} recurring bill${notes.recurringObligationCount === 1 ? "" : "s"}`,
    );
  }
  if (parts.length === 0) return null;

  return (
    <div className="rounded-md border border-line-subtle bg-surface-sunken px-4 py-3">
      <p className="text-meta leading-relaxed text-ink-secondary">
        Working from {parts.join(" and ")} found in your history
        {notes.transactionsFromDate ? ` since ${notes.transactionsFromDate}` : ""}.
      </p>
      {notes.accountsMissingBalance.length > 0 && (
        <p className="mt-1.5 text-meta leading-relaxed text-ink-tertiary">
          No balance for {notes.accountsMissingBalance.join(", ")} — the answer may come back as
          unknown until one is set.
        </p>
      )}
    </div>
  );
}

/**
 * The one thing derivation can't establish, asked of the person who can.
 *
 * The engine refuses to answer until required-obligation coverage is confirmed
 * (`COVERAGE_INCOMPLETE`), and it is right to: a projection built over an
 * unknown share of someone's bills would look precise and be wrong. Nothing
 * read off a statement can flip that flag — an account that was never imported
 * leaves no trace in the one that was.
 *
 * So the list is shown and the question is asked plainly. Confirming is the
 * user's statement about their own finances, not a checkbox to get past.
 */
function ConfirmObligations({
  obligations,
  confirmed,
  onChange,
}: {
  obligations: { id: string; label: string; amountCents: number }[];
  confirmed: boolean;
  onChange: (confirmed: boolean) => void;
}) {
  return (
    <div className="rounded-md border border-line-subtle bg-surface-sunken px-4 py-3">
      <p className="text-body text-ink">These are the regular bills found in your history:</p>
      <ul className="mt-2 space-y-1">
        {obligations.map((obligation) => (
          <li key={obligation.id} className="flex justify-between gap-3 text-meta text-ink-secondary">
            <span className="truncate">{obligation.label}</span>
            <span className="tabular shrink-0">{formatMoney(Math.abs(obligation.amountCents))}</span>
          </li>
        ))}
      </ul>
      <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-body text-ink-secondary">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => onChange(event.target.checked)}
          className="mt-1 h-4 w-4"
        />
        <span>
          That's all my required bills for the next month.
          <span className="mt-0.5 block text-meta text-ink-tertiary">
            Rent, loan payments, or anything paid from an account you haven't imported won't be
            here. Without this the answer stays "not enough information".
          </span>
        </span>
      </label>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-2 block text-label text-ink-secondary">
        {label}
      </label>
      {children}
    </div>
  );
}
