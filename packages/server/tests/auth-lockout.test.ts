/**
 * Per-account brute-force lockout.
 *
 * Wave 2 added a credential-aware throttle beneath the coarse per-IP rate limit:
 * after LOCKOUT_THRESHOLD (10) failed sign-ins for one email inside the window,
 * that email is locked with a 429 TOO_MANY_ATTEMPTS — and, crucially, the lock is
 * checked *before* the password is verified, so a correct password does not open
 * a locked account. None of that had a test, which for a security control means
 * it could silently stop working. These drive the real `AuthService.login`, the
 * same method the route calls, so the lock, its precedence over verification, and
 * its reset-on-success are all pinned to behaviour rather than to the comment
 * that describes them.
 */
import { describe, expect, it } from "vitest";

import { buildAuthService } from "../src/auth/build";
import type { AuthConfig } from "../src/auth/config";
import type { AuthError } from "../src/auth/errors";
import type { AuthService } from "../src/auth/service";

const DAY_MS = 24 * 60 * 60 * 1000;
const EMAIL = "victim@example.com";
const GOOD_PASSWORD = "correct-horse-battery";
const BAD_PASSWORD = "not-the-password";

function config(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return { mode: "multi_user", sessionTtlMs: 30 * DAY_MS, registrationOpen: true, passwordMinLength: 8, ...overrides };
}

async function freshServiceWithVictim(): Promise<AuthService> {
  const service = buildAuthService(config(), { persistence: "memory" });
  await service.register({ email: EMAIL, password: GOOD_PASSWORD });
  return service;
}

/** Run a login expected to fail and hand back the AuthError it threw, so a test
 *  can assert on the stable `code`/`status` instead of message text. */
async function loginError(service: AuthService, password: string): Promise<AuthError> {
  try {
    await service.login({ email: EMAIL, password });
  } catch (error) {
    return error as AuthError;
  }
  throw new Error("expected login to reject, but it resolved");
}

describe("account lockout", () => {
  it("locks the account with 429 only after the tenth failed attempt", async () => {
    const service = await freshServiceWithVictim();

    // The first ten wrong passwords are ordinary credential failures: the lock is
    // armed on the tenth (count reaches the threshold) but only takes effect on
    // the *next* attempt, because the check runs before this one records.
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const error = await loginError(service, BAD_PASSWORD);
      expect(error.code, `attempt ${attempt}`).toBe("INVALID_CREDENTIALS");
      expect(error.status, `attempt ${attempt}`).toBe(401);
    }

    const locked = await loginError(service, BAD_PASSWORD);
    expect(locked.code).toBe("TOO_MANY_ATTEMPTS");
    expect(locked.status).toBe(429);
  });

  it("keeps a locked account shut even against the correct password", async () => {
    // The whole point of the lock is that it precedes verification — otherwise an
    // attacker who eventually guesses right walks straight in. Trip the lock, then
    // present the real password and confirm it is still refused with 429.
    const service = await freshServiceWithVictim();
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      await loginError(service, BAD_PASSWORD);
    }

    const withRealPassword = await loginError(service, GOOD_PASSWORD);
    expect(withRealPassword.code).toBe("TOO_MANY_ATTEMPTS");
    expect(withRealPassword.status).toBe(429);
  });

  it("resets the failure tally on a successful sign-in", async () => {
    // A user who fumbles the password a few times then gets it right must not be
    // one slip away from a lockout afterwards. Nine failures, one success, then a
    // full nine failures again should still be short of the threshold.
    const service = await freshServiceWithVictim();

    for (let attempt = 1; attempt <= 9; attempt += 1) {
      await loginError(service, BAD_PASSWORD);
    }

    const ok = await service.login({ email: EMAIL, password: GOOD_PASSWORD });
    expect(ok.token).toBeTruthy();

    for (let attempt = 1; attempt <= 9; attempt += 1) {
      const error = await loginError(service, BAD_PASSWORD);
      expect(error.code, `post-reset attempt ${attempt}`).toBe("INVALID_CREDENTIALS");
    }
  });

  it("locks a nonexistent email too, so probing cannot dodge the throttle", async () => {
    // recordLoginFailure fires whether or not the account exists, and the lock is
    // keyed by the submitted email. An attacker enumerating addresses gets the
    // same 429 wall — they cannot tell "locked real account" from "locked unknown
    // address", and cannot sidestep the throttle by targeting one that is absent.
    const service = buildAuthService(config(), { persistence: "memory" });

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const error = await loginError(service, BAD_PASSWORD);
      expect(error.code, `attempt ${attempt}`).toBe("INVALID_CREDENTIALS");
    }

    const locked = await loginError(service, BAD_PASSWORD);
    expect(locked.code).toBe("TOO_MANY_ATTEMPTS");
    expect(locked.status).toBe(429);
  });
});
