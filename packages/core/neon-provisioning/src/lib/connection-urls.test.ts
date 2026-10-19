import { describe, expect, it } from 'vitest';
import { connectionUrlsFor, directUrlOf } from './connection-urls';

describe('directUrlOf', () => {
  it('drops -pooler from the host and keeps everything else', () => {
    expect(
      directUrlOf('postgresql://role_x:abc123@ep-cool-123456-pooler.eu-central-1.aws.neon.tech/ws_x?sslmode=require'),
    ).toBe('postgresql://role_x:abc123@ep-cool-123456.eu-central-1.aws.neon.tech/ws_x?sslmode=require');
  });

  it('leaves a URL that is already direct unchanged', () => {
    const direct = 'postgresql://role_x:abc123@ep-cool-123456.eu-central-1.aws.neon.tech/ws_x?sslmode=require';
    expect(directUrlOf(direct)).toBe(direct);
  });

  it('does not touch "-pooler" appearing in the credentials or the database name', () => {
    expect(
      directUrlOf('postgresql://role-pooler:pw%40-pooler@ep-a-pooler.r.neon.tech/db-pooler?sslmode=require'),
    ).toBe('postgresql://role-pooler:pw%40-pooler@ep-a.r.neon.tech/db-pooler?sslmode=require');
  });

  it('copes with a port after the host', () => {
    expect(directUrlOf('postgresql://u:p@ep-a-pooler.r.neon.tech:5432/db')).toBe('postgresql://u:p@ep-a.r.neon.tech:5432/db');
  });

  it('returns a string with no credentials as it is', () => {
    expect(directUrlOf('not a url')).toBe('not a url');
  });
});

describe('connectionUrlsFor', () => {
  it('builds the pooled URL from the direct host, and the direct one as given', () => {
    const urls = connectionUrlsFor('ep-a.eu-central-1.aws.neon.tech', 'role x', 'p@ss/word', 'ws_x');
    expect(urls.pooledUrl).toBe(
      'postgresql://role%20x:p%40ss%2Fword@ep-a-pooler.eu-central-1.aws.neon.tech/ws_x?sslmode=require',
    );
    expect(urls.directUrl).toBe(
      'postgresql://role%20x:p%40ss%2Fword@ep-a.eu-central-1.aws.neon.tech/ws_x?sslmode=require',
    );
  });

  it('round-trips with directUrlOf', () => {
    const { pooledUrl, directUrl } = connectionUrlsFor('ep-a.r.neon.tech', 'u', 'p', 'db');
    expect(directUrlOf(pooledUrl)).toBe(directUrl);
  });
});
