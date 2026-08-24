/**
 * Settings — the app's preferences surface.
 *
 * Today it holds two things: the theme control (mirrored from the sidebar) and
 * the assistant-coin controls. The coin is lively by default; some people find
 * a moving mascot distracting, so this is where they calm it down or turn it
 * off entirely — from one "Calm" tap to the individual switches behind it.
 *
 * All state lives in `mascot-prefs` (a shared, localStorage-backed store), so a
 * change here reaches the already-mounted coin in the same tick — the corner
 * updates live as you toggle. Nothing here is financial; it's pure presentation.
 */
import { useEffect, useState, type ReactNode } from "react";
import {
  useMascotPrefs,
  MASCOT_PRESETS,
  mascotPresetOf,
  type MascotCharacter,
  type MascotPreset,
} from "../mascot-prefs";
import { Card, SectionLabel, Segmented, TrailDivider } from "../components/ui";
import { ThemeToggle } from "../components/ThemeToggle";
import { MfaSetupCard } from "../components/Mfa";
import { fetchAgentStatus, type AgentStatus } from "../services/agent";

const PRESETS: { key: MascotPreset; label: string; blurb: string }[] = [
  { key: "lively", label: "Lively", blurb: "Rolls and peeks — the default." },
  { key: "calm", label: "Calm", blurb: "Still coin; the guy stays on screen." },
  { key: "off", label: "Off", blurb: "Hide the coin entirely." },
];

const CHARACTER_OPTIONS: { value: MascotCharacter; label: string }[] = [
  { value: "auto", label: "Peeks now & then" },
  { value: "always", label: "Always visible" },
  { value: "off", label: "Hidden" },
];

const CHARACTER_HELP: Record<MascotCharacter, string> = {
  auto: "The little guy climbs up to say hi every so often.",
  always: "The guy and his thought-bubble stay on screen the whole time.",
  off: "The guy never appears — just the coin.",
};

/** Read the OS reduced-motion preference and keep it current, for an honest note
 *  that these controls can't override it. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

export function SettingsScreen() {
  const { prefs, setPrefs, update } = useMascotPrefs();
  const activePreset = mascotPresetOf(prefs);
  const reduced = usePrefersReducedMotion();

  return (
    <div className="mx-auto max-w-[680px]">
      <h1 className="mb-6 font-display text-[1.5rem] font-medium tracking-[-0.01em] text-ink">
        Settings
      </h1>

      <div className="space-y-5">
        {/* ---- Appearance ---- */}
        <Card>
          <SectionLabel>Appearance</SectionLabel>
          <Row
            label="Theme"
            description="Light, dark, or follow your device."
            control={<ThemeToggle />}
          />
        </Card>

        {/* ---- Security (multi-user only; renders nothing otherwise) ---- */}
        <MfaSetupCard />

        {/* ---- Privacy & data ---- */}
        <PrivacyCard />

        {/* ---- Assistant coin ---- */}
        <Card>
          <SectionLabel>Assistant coin</SectionLabel>
          <p className="text-body text-ink-secondary">
            The gold “b” in the corner — a page-aware helper. It idly rolls and
            the little guy behind it peeks over the rim now and then. Tune or turn
            that down here; you can still reach the assistant from the sidebar.
          </p>

          {/* Quick presets */}
          <div className="mt-4">
            <p className="mb-2 text-label text-ink-secondary">Quick setting</p>
            <div className="grid gap-2 sm:grid-cols-3">
              {PRESETS.map((p) => {
                const active = activePreset === p.key;
                return (
                  <button
                    key={p.key}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setPrefs({ ...MASCOT_PRESETS[p.key] })}
                    className={`rounded-lg border p-3 text-left transition-colors ${
                      active
                        ? "border-accent bg-accent/5"
                        : "border-line-subtle hover:border-line-strong"
                    }`}
                  >
                    <span
                      className={`block text-label ${active ? "text-ink" : "text-ink-secondary"}`}
                    >
                      {p.label}
                    </span>
                    <span className="mt-0.5 block text-meta text-ink-tertiary">{p.blurb}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <TrailDivider className="my-4" />

          {/* Granular controls */}
          <Row
            label="Show the coin"
            description="Turn the whole thing off. The assistant stays in the sidebar."
            control={
              <Toggle
                checked={prefs.visible}
                onChange={(v) => update({ visible: v })}
                label="Show the coin"
              />
            }
          />

          {/* Movement + character only matter while the coin is shown. */}
          <div
            className={
              prefs.visible ? "" : "pointer-events-none select-none opacity-45"
            }
            aria-hidden={!prefs.visible}
          >
            <Row
              label="Idle movement"
              description="The coin rolling and flicking on its own."
              control={
                <Toggle
                  checked={prefs.movement}
                  onChange={(v) => update({ movement: v })}
                  label="Idle movement"
                  disabled={!prefs.visible}
                />
              }
            />

            <div className="py-3">
              <div className="mb-2 flex items-baseline justify-between gap-4">
                <p className="text-body text-ink">The little guy</p>
              </div>
              <Segmented
                ariaLabel="How the assistant character behaves"
                options={CHARACTER_OPTIONS}
                value={prefs.character}
                onChange={(next) => update({ character: next })}
              />
              <p className="mt-2 text-meta text-ink-tertiary">{CHARACTER_HELP[prefs.character]}</p>
            </div>
          </div>

          {reduced && (
            <p className="mt-3 rounded-md bg-surface-sunken px-3 py-2 text-meta text-ink-tertiary">
              Your device has reduced motion turned on, so the coin stays still
              regardless of the movement setting above.
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}

// ---- Privacy & data ---------------------------------------------------------

type PrivacyTone = "onDevice" | "leaves" | "thirdParty" | "planned";

type PrivacyRowData = {
  title: string;
  body: string;
  badge: { label: string; tone: PrivacyTone };
};

function toneClass(tone: PrivacyTone): string {
  switch (tone) {
    case "onDevice":
      return "bg-rise-soft text-rise";
    case "leaves":
      return "bg-alert-soft text-alert";
    default:
      return "bg-surface-sunken text-ink-secondary";
  }
}

/**
 * An honest, status-driven account of where the user's data lives and the few
 * moments any of it leaves this machine. Everything here is read from the live
 * `/agent/status` so it can't drift from reality: if chat runs on a hosted
 * model, this says questions leave per turn; if it's local, it says they don't.
 *
 * The load-bearing honesty is the first row — there is no cloud database in this
 * codebase, so "stored on this machine" is a fact, not a promise. The last row
 * is the only forward-looking claim, and it's flagged "Planned".
 */
function PrivacyCard() {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchAgentStatus().then((outcome) => {
      if (cancelled) return;
      setStatus(outcome.kind === "ok" ? outcome.data : null);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Card>
      <SectionLabel>Privacy &amp; data</SectionLabel>
      <p className="mt-1 text-body text-ink-secondary">
        Where your information is kept, and the few moments any of it leaves this machine.
      </p>
      <div className="mt-4 space-y-3">
        {buildPrivacyRows(status).map((row) => (
          <PrivacyRow key={row.title} {...row} />
        ))}
      </div>
      {loaded && !status && (
        <p className="mt-3 text-meta text-ink-tertiary">
          Couldn&rsquo;t reach the server to confirm the assistant&rsquo;s setup, so its rows are
          hidden — the storage facts above hold regardless.
        </p>
      )}
    </Card>
  );
}

/** Build the rows from live status. The storage, bank, and sync rows are always
 *  true; the assistant and import rows appear only once status confirms how each
 *  is configured, so the panel never guesses whether data leaves the machine. */
function buildPrivacyRows(status: AgentStatus | null): PrivacyRowData[] {
  const rows: PrivacyRowData[] = [
    {
      title: "On this device",
      body:
        "Your accounts, transactions, imported statements, uploaded files, saved facts, and chat history are stored as plain files on the machine that runs Breadcrumbz. There is no shared cloud database — nothing is copied to an outside server for us to hold.",
      badge: { label: "On device", tone: "onDevice" },
    },
  ];

  if (status?.configured) {
    rows.push(
      status.offline
        ? {
            title: "The assistant",
            body: "Runs on this machine. The questions you ask and the figures it reads never leave it.",
            badge: { label: "On device", tone: "onDevice" },
          }
        : {
            title: "The assistant",
            body:
              "Runs on a hosted model (Anthropic). When you ask something, the text of your question and the figures the assistant reads are sent there to write the reply. Your stored data stays on this machine.",
            badge: { label: "Leaves per question", tone: "leaves" },
          },
    );
  }

  if (status?.extractionProvider) {
    rows.push(
      status.extractionOffline
        ? {
            title: "Importing a statement",
            body: "The PDF is read on this machine. It never leaves it.",
            badge: { label: "On device", tone: "onDevice" },
          }
        : {
            title: "Importing a statement",
            body:
              "When you import a PDF, its text is sent once to a hosted model to read it into transactions. The result is then kept on this machine.",
            badge: { label: "Leaves on import", tone: "leaves" },
          },
    );
  }

  rows.push(
    {
      title: "Connecting a bank",
      body:
        "Linking an account goes through Plaid, a third party that brokers the bank connection. Your bank credentials go to Plaid, never to us — Breadcrumbz receives only the transactions, which are then stored on this machine.",
      badge: { label: "Third party", tone: "thirdParty" },
    },
    {
      title: "The same data on another device",
      body:
        "Everything lives on this one machine today, so signing in elsewhere won't show the same data. Cross-device sync is planned as an opt-in — and when it ships, your synced copy will be end-to-end encrypted, so not even we can read it. Until you turn it on, nothing syncs.",
      badge: { label: "Planned", tone: "planned" },
    },
  );

  return rows;
}

function PrivacyRow({ title, body, badge }: PrivacyRowData) {
  return (
    <div className="rounded-lg border border-line-subtle p-3">
      <div className="mb-1 flex items-center justify-between gap-3">
        <p className="text-label text-ink">{title}</p>
        <span className={`flex-none rounded-pill px-2 py-0.5 text-meta ${toneClass(badge.tone)}`}>
          {badge.label}
        </span>
      </div>
      <p className="text-meta leading-relaxed text-ink-secondary">{body}</p>
    </div>
  );
}

/** A label/description on the left, a control on the right. */
function Row({
  label,
  description,
  control,
}: {
  label: string;
  description?: string;
  control: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="text-body text-ink">{label}</p>
        {description && <p className="mt-0.5 text-meta text-ink-tertiary">{description}</p>}
      </div>
      <div className="flex-none">{control}</div>
    </div>
  );
}

/** An accessible on/off switch. */
function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-[26px] w-[46px] items-center rounded-pill border transition-colors ${
        checked ? "border-accent bg-accent" : "border-line-strong bg-surface-sunken"
      } ${disabled ? "cursor-not-allowed opacity-40" : ""}`}
    >
      <span
        className={`absolute h-[20px] w-[20px] rounded-pill bg-surface-raised shadow-sm transition-transform ${
          checked ? "translate-x-[22px]" : "translate-x-[2px]"
        }`}
      />
    </button>
  );
}
