import { z } from "zod";

/**
 * Plaid runtime configuration.
 *
 * `env` selects which Plaid environment the client talks to: `sandbox` uses test
 * institutions and fake credentials, `production` connects real banks and moves
 * against real accounts. Plaid retired its old "development" tier, so the SDK
 * exposes only these two base paths — there is no third option to support.
 *
 * Nothing here is a secret literal; the values come from the environment. Errors
 * are surfaced through `PlaidConfigError`, which is careful never to echo the
 * secret back in its message.
 */
const PlaidConfigSchema = z.object({
  env: z.enum(["sandbox", "production"]),
  clientId: z.string().min(1),
  secret: z.string().min(1),
  clientName: z.string().min(1).max(30).default("Breadcrumbz"),
  countryCodes: z.array(z.literal("US")).min(1).default(["US"]),
  redirectUri: z.string().url().optional(),
  webhook: z.string().url().optional(),
});

export type PlaidConfig = z.infer<typeof PlaidConfigSchema>;

export class PlaidConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid Plaid configuration: ${issues.join("; ")}`);
    this.name = "PlaidConfigError";
    this.issues = issues;
  }
}

export function loadPlaidConfig(env: NodeJS.ProcessEnv = process.env): PlaidConfig {
  const parsed = PlaidConfigSchema.safeParse({
    env: env.PLAID_ENV,
    clientId: env.PLAID_CLIENT_ID,
    secret: env.PLAID_SECRET,
    clientName: env.PLAID_CLIENT_NAME || undefined,
    countryCodes: parseCountryCodes(env.PLAID_COUNTRY_CODES),
    redirectUri: emptyToUndefined(env.PLAID_REDIRECT_URI),
    webhook: emptyToUndefined(env.PLAID_WEBHOOK),
  });

  if (!parsed.success) {
    // Map to `path: message` — the Zod issue never contains the input value, so
    // a bad secret cannot leak into a log line built from this.
    throw new PlaidConfigError(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
  }

  return parsed.data;
}

function parseCountryCodes(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean);
}

function emptyToUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
