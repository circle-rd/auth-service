/**
 * Password-strength scoring for the password forms.
 *
 * The server (BetterAuth `emailAndPassword` in `src/auth.ts`) enforces exactly
 * two rules: at least `minPasswordLength` characters and at most
 * BetterAuth's default `maxPasswordLength`. The indicator below *reflects*
 * that policy — it never blocks a password the server would accept — and only
 * scores the remaining strength so the user gets a nudge, not a gate.
 */

/** Mirrors `minPasswordLength` in `src/auth.ts`. */
export const MIN_PASSWORD_LENGTH = 8;

/** BetterAuth's default `maxPasswordLength`; a longer value is refused too. */
export const MAX_PASSWORD_LENGTH = 128;

export type PasswordStrengthLevel = 'weak' | 'fair' | 'good' | 'strong';

export interface PasswordStrength {
  /** 1 (weak) to 4 (strong), 0 when the field is empty. */
  score: 0 | 1 | 2 | 3 | 4;
  level: PasswordStrengthLevel | null;
  /** Whether the server would accept this password at all. */
  acceptable: boolean;
}

const LEVELS: PasswordStrengthLevel[] = ['weak', 'fair', 'good', 'strong'];

export function passwordStrength(password: string): PasswordStrength {
  if (!password) return { score: 0, level: null, acceptable: false };

  const acceptable =
    password.length >= MIN_PASSWORD_LENGTH &&
    password.length <= MAX_PASSWORD_LENGTH;
  if (!acceptable) return { score: 1, level: 'weak', acceptable };

  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) =>
    re.test(password),
  ).length;

  let score = 1;
  if (classes >= 2) score += 1;
  if (classes >= 3) score += 1;
  if (password.length >= 12) score += 1;

  const clamped = Math.min(4, score) as 1 | 2 | 3 | 4;
  return { score: clamped, level: LEVELS[clamped - 1], acceptable };
}
