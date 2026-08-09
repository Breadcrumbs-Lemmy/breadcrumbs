/** Tokens live in src/styles/tokens.css. Tailwind references them; it never
 *  defines them. See docs/ui-design-system.md. */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: {
          base: "var(--surface-base)",
          raised: "var(--surface-raised)",
          sunken: "var(--surface-sunken)",
          inset: "var(--surface-inset)",
        },
        line: {
          subtle: "var(--border-subtle)",
          strong: "var(--border-strong)",
        },
        ink: {
          DEFAULT: "var(--text-primary)",
          secondary: "var(--text-secondary)",
          tertiary: "var(--text-tertiary)",
          inverse: "var(--text-inverse)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          hover: "var(--accent-hover)",
          soft: "var(--accent-soft)",
          ink: "var(--accent-ink)",
        },
        rise: { DEFAULT: "var(--rise)", soft: "var(--rise-soft)" },
        fall: { DEFAULT: "var(--fall)", soft: "var(--fall-soft)" },
        alert: { DEFAULT: "var(--alert)", soft: "var(--alert-soft)" },
        level: { fg: "var(--level-fg)", bg: "var(--level-bg)", border: "var(--level-border)" },
        data: {
          required: "var(--data-required)",
          protected: "var(--data-protected)",
          allEvents: "var(--data-all-events)",
          expected: "var(--data-expected)",
          buffer: "var(--data-buffer)",
          zero: "var(--data-zero)",
        },
      },
      fontFamily: {
        sans: "var(--font-sans)",
        display: "var(--font-display)",
        mono: "var(--font-mono)",
      },
      backgroundImage: {
        brand: "var(--brand-gradient)",
        "brand-soft": "var(--brand-gradient-soft)",
      },
      fontSize: {
        hero: ["2.75rem", { lineHeight: "1.04", letterSpacing: "-0.024em", fontWeight: "560" }],
        figure: ["1.75rem", { lineHeight: "1.1", letterSpacing: "-0.02em", fontWeight: "560" }],
        amount: ["1.0625rem", { lineHeight: "1.3", letterSpacing: "-0.01em", fontWeight: "500" }],
        heading: ["1.0625rem", { lineHeight: "1.45", fontWeight: "560" }],
        body: ["0.9375rem", { lineHeight: "1.55" }],
        label: ["0.8125rem", { lineHeight: "1.35", fontWeight: "500", letterSpacing: "0.005em" }],
        meta: ["0.75rem", { lineHeight: "1.35", letterSpacing: "0.01em" }],
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
        pill: "var(--radius-pill)",
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
        card: "var(--shadow-sm)",
      },
      transitionTimingFunction: {
        out: "var(--ease-out)",
        spring: "var(--ease-spring)",
      },
    },
  },
  plugins: [],
};
