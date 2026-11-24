import { describe, expect, it } from 'vitest';
import { hostsMatch, isPublicSuffix } from './weldpass-passwords';

describe('isPublicSuffix', () => {
  it.each(['com', 'co.uk', 'github.io', 'blogspot.com', 'test'])('%s is one', (host) => {
    expect(isPublicSuffix(host)).toBe(true);
  });

  it.each(['example.com', 'example.co.uk', 'a.github.io', 'acme-match.test', '127.0.0.1'])(
    '%s is not',
    (host) => {
      expect(isPublicSuffix(host)).toBe(false);
    },
  );
});

describe('hostsMatch', () => {
  it.each([
    ['example.com', 'example.com'],
    ['example.com', 'accounts.example.com'],
    ['accounts.example.com', 'example.com'],
    ['example.co.uk', 'www.example.co.uk'],
    ['a.github.io', 'login.a.github.io'],
    ['localhost', 'localhost'],
    ['127.0.0.1', '127.0.0.1'],
    // The same host matches even when it is a public suffix itself.
    ['github.io', 'github.io'],
  ])('offers a login for %s on %s', (item, page) => {
    expect(hostsMatch(item, page)).toBe(true);
  });

  it.each([
    ['example.com', 'notexample.com'],
    ['a.example.com', 'b.example.com'],
    ['com', 'example.com'],
    // Anyone can register under a public suffix: the parent is no one's site.
    ['a.github.io', 'github.io'],
    ['github.io', 'a.github.io'],
    ['a.github.io', 'b.github.io'],
    ['co.uk', 'example.co.uk'],
    ['example.co.uk', 'co.uk'],
    ['x.blogspot.com', 'blogspot.com'],
    // IP addresses only ever match themselves.
    ['0.0.1', '127.0.0.1'],
    ['localhost', 'app.localhost'],
  ])('never offers a login for %s on %s', (item, page) => {
    expect(hostsMatch(item, page)).toBe(false);
  });
});
