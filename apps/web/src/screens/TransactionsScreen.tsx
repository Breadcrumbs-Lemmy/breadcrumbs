/**
 * Transactions — the drill-down that makes every aggregate trustworthy.
 *
 * A user who cannot see the rows behind "Groceries $419.70" has to take the
 * number on faith. Transfers, refunds, and unresolved movement are shown here
 * with badges explaining why they are excluded from spending totals, so the
 * list and the summary visibly reconcile.
 *
 * The list itself lives in `components/TransactionList` — the same component the
 * Accounts screen uses, scoped to one account. Here it runs unscoped across
 * every account, with a per-row account tag so each line says which account it
 * belongs to.
 *
 * When arrived at from an insight ("See the 9 transactions"), `focus` scopes the
 * list to exactly those transactions so the claim is verifiable — landing on the
 * full, unfiltered list would make the link useless. `focus` also carries the
 * insight's backend total, shown at the foot of the list, and `onBack` returns
 * to the Insights screen the drill-down came from.
 */
import { TransactionList } from "../components/TransactionList";
import type { InsightFocus } from "../model/insight-focus";

export function TransactionsScreen({
  focus,
  onClearFocus,
  onBack,
}: {
  focus?: InsightFocus;
  onClearFocus?: () => void;
  onBack?: () => void;
}) {
  return (
    <div className="mx-auto w-full max-w-[760px]">
      <TransactionList
        showAccountTag
        focus={focus}
        onClearFocus={onClearFocus}
        onBack={onBack}
      />
    </div>
  );
}
