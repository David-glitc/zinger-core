import { afterEach, describe, expect, it } from 'vitest';
import {
  isAuthConfigured,
  passwordsMatch,
  issueToken,
  verifyToken,
  parseCookies,
} from '../../src/lib/auth.js';

const PREV = {
  AUTH_PASSWORD: process.env.AUTH_PASSWORD,
  AUTH_SECRET: process.env.AUTH_SECRET,
  ZINGER_PASSWORD: process.env.ZINGER_PASSWORD,
};

afterEach(() => {
  for (const [k, v] of Object.entries(PREV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('auth', () => {
  it('reports configured only when password is set', () => {
    delete process.env.AUTH_PASSWORD;
    delete process.env.ZINGER_PASSWORD;
    delete process.env.AUTH_SECRET;
    expect(isAuthConfigured()).toBe(false);

    process.env.AUTH_PASSWORD = 'test-pass';
    expect(isAuthConfigured()).toBe(true);
  });

  it('matches passwords with timing-safe compare', () => {
    process.env.AUTH_PASSWORD = 'correct-horse';
    expect(passwordsMatch('correct-horse')).toBe(true);
    expect(passwordsMatch('wrong')).toBe(false);
  });

  it('issues and verifies HMAC tokens', () => {
    process.env.AUTH_PASSWORD = 'correct-horse';
    process.env.AUTH_SECRET = 'unit-test-secret';
    const token = issueToken();
    expect(verifyToken(token)).toMatchObject({ v: 1 });
    expect(verifyToken('not.a.token')).toBeNull();
    expect(verifyToken(`${token}x`)).toBeNull();
  });

  it('parses cookie headers', () => {
    expect(parseCookies('a=1; b=two%20parts')).toEqual({ a: '1', b: 'two parts' });
    expect(parseCookies('')).toEqual({});
  });
});
