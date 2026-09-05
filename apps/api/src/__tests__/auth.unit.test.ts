import { describe, expect, it } from 'vitest';
import { checkPasswordStrength } from '../lib/password';
import { parseDuration, sha256 } from '../lib/tokens';

describe('password strength', () => {
  it('rejects short passwords', () => {
    const result = checkPasswordStrength('Abc12');
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('10 characters');
  });

  it('rejects passwords with no digit', () => {
    expect(checkPasswordStrength('abcdefghijkl').ok).toBe(false);
  });

  it('rejects well-known passwords', () => {
    expect(checkPasswordStrength('mypassword123').ok).toBe(false);
  });

  it('rejects a password containing the user name', () => {
    const result = checkPasswordStrength('aarav-sharma-99', ['aarav']);
    expect(result.ok).toBe(false);
  });

  it('accepts a reasonable password', () => {
    expect(checkPasswordStrength('quietRiver42lamp', ['meera']).ok).toBe(true);
  });
});

describe('duration parsing', () => {
  it.each([
    ['45s', 45_000],
    ['15m', 900_000],
    ['12h', 43_200_000],
    ['30d', 2_592_000_000],
  ])('parses %s', (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it('throws on an unsupported unit', () => {
    expect(() => parseDuration('2w')).toThrow();
  });
});

describe('token hashing', () => {
  it('is deterministic and fixed width', () => {
    const hash = sha256('a-refresh-token');
    expect(hash).toHaveLength(64);
    expect(sha256('a-refresh-token')).toBe(hash);
  });

  it('differs for different inputs', () => {
    expect(sha256('one')).not.toBe(sha256('two'));
  });
});
