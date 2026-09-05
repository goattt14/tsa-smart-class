import bcrypt from 'bcryptjs';
import { env } from '../config/env';

/**
 * bcryptjs is pure JavaScript. It is slower than the native `bcrypt` binding,
 * but it never fails to compile on a Render free instance, which matters more
 * than the milliseconds here.
 */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, env.BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

/**
 * Constant-ish work even when no user exists, so response timing does not
 * reveal whether an email is registered. The hash below is a real bcrypt digest
 * of a random string; comparing against it costs the same as a genuine check.
 */
const DECOY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEe.4hoPzcCEwPPRTLwLvGSFqcYcqZFepIu';

export async function burnPasswordTime(plain: string): Promise<void> {
  await verifyPassword(plain, DECOY_HASH);
}

export interface PasswordCheck {
  ok: boolean;
  problems: string[];
}

/**
 * Length is the dominant factor, so the rules stay light: enough to stop
 * "123456" without pushing people toward "Password1!" written on a desk.
 */
export function checkPasswordStrength(plain: string, context: string[] = []): PasswordCheck {
  const problems: string[] = [];

  if (plain.length < 10) problems.push('Use at least 10 characters.');
  if (plain.length > 128) problems.push('Use at most 128 characters.');
  if (!/[a-zA-Z]/.test(plain)) problems.push('Include at least one letter.');
  if (!/[0-9]/.test(plain)) problems.push('Include at least one number.');

  const lowered = plain.toLowerCase();
  const common = ['password', 'qwerty', '12345678', 'letmein', 'admin123', 'welcome1'];
  if (common.some((c) => lowered.includes(c))) {
    problems.push('That password is too easy to guess.');
  }

  for (const piece of context) {
    const token = piece?.toLowerCase().trim();
    if (token && token.length >= 4 && lowered.includes(token)) {
      problems.push('Do not reuse your name or email inside the password.');
      break;
    }
  }

  return { ok: problems.length === 0, problems };
}
