import { describe, expect, it } from 'vitest';
import { resolveUniqueSlug } from './onboard';

/** A master DB where the given slugs are taken. */
function masterDbWith(taken: string[]) {
  const seen: string[] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: (condition: { queryChunks?: unknown[] }) => ({
          limit: async () => {
            // eq(workspaces.slug, candidate): the bound value is the last chunk.
            const param = (condition.queryChunks ?? []).find(
              (chunk): chunk is { value: string } =>
                typeof chunk === 'object' && chunk !== null && typeof (chunk as { value?: unknown }).value === 'string',
            );
            const slug = param?.value ?? '';
            seen.push(slug);
            return taken.includes(slug) ? [{ id: 'ws_taken' }] : [];
          },
        }),
      }),
    }),
  };
  return { db: db as unknown as Parameters<typeof resolveUniqueSlug>[0], seen };
}

describe('resolveUniqueSlug', () => {
  it('keeps a free, valid slug', async () => {
    const { db } = masterDbWith([]);
    expect(await resolveUniqueSlug(db, 'acme', 'ws_0123456789abcdef')).toBe('acme');
  });

  it('suffixes a taken slug with the workspace id tail', async () => {
    const { db } = masterDbWith(['acme']);
    expect(await resolveUniqueSlug(db, 'acme', 'ws_0123456789abcdef')).toBe('acme-abcdef');
  });

  it('never stores a reserved slug, even when Clerk picked it', async () => {
    const { db, seen } = masterDbWith([]);
    expect(await resolveUniqueSlug(db, 'settings', 'ws_0123456789abcdef')).toBe('workspace-settings');
    expect(await resolveUniqueSlug(db, 'weldcrm', 'ws_0123456789abcdef')).toBe('workspace-weldcrm');
    expect(seen).not.toContain('settings');
  });

  it('repairs a malformed slug', async () => {
    const { db } = masterDbWith([]);
    expect(await resolveUniqueSlug(db, 'Acme_Corp', 'ws_0123456789abcdef')).toBe('acme-corp');
  });
});
