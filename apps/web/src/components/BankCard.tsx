/**
 * BankCard — a physical-feeling card for one account.
 *
 * The face shows the institution, an EMV chip, and a card number; on hover (or
 * keyboard focus, or when a wrapping `.bankcard-flip` ancestor is hovered) it
 * turns on its vertical axis to reveal the back — the masked account details.
 * The turn, chip, stripe, and 3D geometry all live in the `.bankcard*` classes
 * in styles/index.css; this file only fills the two faces.
 *
 * HONESTY (the finance-app rule that outranks the visual):
 *   We never invent an account digit. The only real digits we hold are the
 *   `mask` — the last four — which the backend supplies when it knows them.
 *   Every other position (the leading groups of the card number, the routing
 *   number, the CVV, the expiry) is genuinely unknown to the browser, so it is
 *   rendered as masking dots — "hidden", never a fabricated value. When even the
 *   last four are absent, the whole number is dots. The dots are the "crossed
 *   out" the user asked for, and they are the truth: we are not holding those
 *   numbers.
 *
 * The card is decorative: everything it conveys (account name, type, balance)
 * also appears as text in the surrounding list, so the root is `aria-hidden` to
 * spare screen-reader users a second, dot-filled reading of the same account.
 */
import type { AccountView } from "@ai-fin-os/core";
import { formatMoney } from "../format/money";

/** A masking dot run of the given length, e.g. •••• . */
function dots(n: number): string {
  return "•".repeat(n);
}

/**
 * The four groups of a card number. Only the final group can ever be real (the
 * `mask`, the last four); the rest are always dots because we do not hold them.
 */
function cardNumberGroups(mask?: string): { text: string; real: boolean }[] {
  return [
    { text: dots(4), real: false },
    { text: dots(4), real: false },
    { text: dots(4), real: false },
    { text: mask && /^\d{4}$/.test(mask) ? mask : dots(4), real: Boolean(mask && /^\d{4}$/.test(mask)) },
  ];
}

/**
 * A card's colourway, chosen deterministically from the account id so a given
 * account always wears the same card, and two cards in a list rarely collide.
 * Debts (credit cards) draw from a darker, premium set; depository accounts get
 * the blues and greens. These are off-palette dark surfaces on purpose — a bank
 * card is its own object, not a themed page element.
 */
const CREDIT_THEMES = [
  "linear-gradient(135deg, #23242a 0%, #0e0e12 100%)",
  "linear-gradient(135deg, #3a1a24 0%, #170a10 100%)",
  "linear-gradient(135deg, #2e2340 0%, #130e1e 100%)",
  "linear-gradient(135deg, #1d1f22 0%, #0a0b0d 100%)",
];
const CASH_THEMES = [
  "linear-gradient(135deg, #1b2c48 0%, #0b1424 100%)",
  "linear-gradient(135deg, #123430 0%, #071712 100%)",
  "linear-gradient(135deg, #16303d 0%, #091a22 100%)",
  "linear-gradient(135deg, #23324a 0%, #0d1524 100%)",
];

function themeFor(account: AccountView): string {
  let hash = 0;
  for (let i = 0; i < account.id.length; i++) {
    hash = (hash * 31 + account.id.charCodeAt(i)) >>> 0;
  }
  const palette = account.isDebt ? CREDIT_THEMES : CASH_THEMES;
  return palette[hash % palette.length]!;
}

function typeLabel(type: AccountView["type"]): string {
  switch (type) {
    case "credit_card":
      return "Credit";
    case "savings":
      return "Savings";
    case "checking":
      return "Checking";
    default:
      return String(type).replace(/_/g, " ");
  }
}

/**
 * The bank to print on the card. When the backend has resolved the institution
 * we use it verbatim. When it hasn't — the connection comes through as
 * "Unknown" — we fall back to the leading brand word of the account name, which
 * for these accounts *is* the real issuer ("Plaid Gold Standard Checking" →
 * "Plaid"). That is a truthful reading of the data we hold, not a fabrication:
 * we're surfacing a name already present in the account, not inventing one.
 */
export function issuerLabel(institutionName: string, accountName: string): string {
  const name = institutionName?.trim();
  if (name && name.toLowerCase() !== "unknown") return name;
  const lead = accountName.trim().split(/\s+/)[0];
  return lead || "Bank";
}

export function BankCard({
  account,
  institutionName,
}: {
  account: AccountView;
  institutionName: string;
}) {
  const groups = cardNumberGroups(account.mask);
  const background = themeFor(account);
  const issuer = issuerLabel(institutionName, account.displayName);
  // The back shows the balance because it is a real, useful figure — the masked
  // fields around it are the "crossed out" numbers.
  const balance = formatMoney(account.currentBalanceCents);

  return (
    <div className="bankcard" aria-hidden="true">
      <div className="bankcard__inner">
        {/* ---- Front ------------------------------------------------------ */}
        <div className="bankcard__face" style={{ background }}>
          <div className="flex h-full flex-col justify-between p-4 sm:p-5">
            <div className="flex items-start justify-between gap-2">
              <span className="truncate text-[0.8rem] font-semibold tracking-wide">
                {issuer}
              </span>
              {/* A neutral two-disc network mark — reads as a card scheme without
                  impersonating one. */}
              <span aria-hidden="true" className="flex shrink-0 items-center">
                <span className="block h-4 w-4 rounded-full" style={{ background: "rgba(255,255,255,0.55)" }} />
                <span className="-ml-1.5 block h-4 w-4 rounded-full" style={{ background: "rgba(255,255,255,0.28)" }} />
              </span>
            </div>

            {/* Chip + number */}
            <div>
              <span className="bankcard__chip relative mb-3 block h-6 w-8 rounded-[5px]" aria-hidden="true" />
              <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 font-mono text-[0.9rem] tracking-[0.12em] sm:text-[1rem]">
                {groups.map((g, i) => (
                  <span key={i} className={g.real ? "" : "opacity-70"}>
                    {g.text}
                  </span>
                ))}
              </div>
            </div>

            {/* Footer: which account, and a masked expiry */}
            <div className="flex items-end justify-between gap-3">
              <div className="min-w-0">
                <span className="block text-[0.55rem] uppercase tracking-[0.16em] opacity-55">
                  Account
                </span>
                <span className="block truncate text-[0.78rem]">{account.displayName}</span>
              </div>
              <div className="shrink-0 text-right">
                <span className="block text-[0.55rem] uppercase tracking-[0.16em] opacity-55">
                  Valid thru
                </span>
                <span className="font-mono text-[0.78rem] tracking-widest">{dots(2)}/{dots(2)}</span>
              </div>
            </div>
          </div>
        </div>

        {/* ---- Back ------------------------------------------------------- */}
        <div className="bankcard__face bankcard__back" style={{ background }}>
          <div className="flex h-full flex-col p-4 sm:p-5">
            {/* Magnetic stripe */}
            <div className="bankcard__stripe -mx-4 mt-1 h-8 sm:-mx-5" aria-hidden="true" />

            {/* Signature panel with a masked CVV */}
            <div className="mt-2.5 flex items-center gap-2">
              <span className="h-6 flex-1 rounded-sm" style={{ background: "rgba(255,255,255,0.82)" }} aria-hidden="true" />
              <span className="font-mono text-[0.72rem] tracking-widest opacity-90">{dots(3)}</span>
            </div>

            {/* Whose card this is: the account name and the bank behind it — the
                first things the user asked to see when the card flips. */}
            <div className="mt-2.5 min-w-0">
              <p className="truncate text-[0.8rem] font-medium leading-tight">{account.displayName}</p>
              <p className="truncate text-[0.64rem] opacity-70">{issuer}</p>
            </div>

            {/* Masked identifiers — the crossed-out numbers */}
            <dl className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[0.66rem]">
              <div className="col-span-2">
                <dt className="uppercase tracking-[0.14em] opacity-55">Account number</dt>
                <dd className="font-mono tracking-[0.1em]">
                  {dots(4)} {dots(4)} {dots(4)}{" "}
                  <span className={account.mask ? "" : "opacity-70"}>
                    {account.mask && /^\d{4}$/.test(account.mask) ? account.mask : dots(4)}
                  </span>
                </dd>
              </div>
              <div>
                <dt className="uppercase tracking-[0.14em] opacity-55">Routing</dt>
                <dd className="font-mono tracking-[0.1em] opacity-70">{dots(9)}</dd>
              </div>
              <div>
                <dt className="uppercase tracking-[0.14em] opacity-55">Type</dt>
                <dd>{typeLabel(account.type)}</dd>
              </div>
            </dl>

            {/* The one real figure — the current balance */}
            <div className="mt-auto flex items-end justify-between gap-2 pt-2">
              <span className="text-[0.55rem] uppercase tracking-[0.16em] opacity-55">
                {account.isDebt ? "Balance owed" : "Balance"}
              </span>
              <span className="font-mono text-[0.82rem]">{balance}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
