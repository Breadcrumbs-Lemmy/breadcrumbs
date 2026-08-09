/**
 * One error type for the whole auth surface, carrying the HTTP status and a
 * stable machine code so routes translate failures uniformly and the browser
 * can branch on `code` rather than parsing a message.
 */
export class AuthError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export const authErrors = {
  invalidCredentials: () => new AuthError("INVALID_CREDENTIALS", 401, "Email or password is incorrect."),
  tooManyAttempts: (retryAfterSeconds: number) =>
    new AuthError(
      "TOO_MANY_ATTEMPTS",
      429,
      `Too many failed sign-in attempts. Try again in about ${Math.ceil(retryAfterSeconds / 60)} minute(s).`,
    ),
  emailTaken: () => new AuthError("EMAIL_TAKEN", 409, "An account with that email already exists."),
  weakPassword: (min: number) =>
    new AuthError("WEAK_PASSWORD", 400, `Password must be at least ${min} characters.`),
  invalidEmail: () => new AuthError("INVALID_EMAIL", 400, "Enter a valid email address."),
  registrationClosed: () => new AuthError("REGISTRATION_CLOSED", 403, "Registration is closed."),
  accountDisabled: () => new AuthError("ACCOUNT_DISABLED", 403, "This account has been disabled."),
  unauthenticated: () => new AuthError("UNAUTHENTICATED", 401, "Sign in to continue."),
  forbidden: () => new AuthError("FORBIDDEN", 403, "You don't have access to that."),
  notFound: () => new AuthError("USER_NOT_FOUND", 404, "No such user."),
  cannotDemoteLastAdmin: () =>
    new AuthError("LAST_ADMIN", 400, "There must be at least one admin. Promote another user first."),
} as const;
