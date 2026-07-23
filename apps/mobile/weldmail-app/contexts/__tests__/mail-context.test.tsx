// MailContext pulls in the Clerk auth context, the app-api client and
// AsyncStorage at import time. Those are stubbed via the jest config
// moduleNameMapper + jest.setup, so we can import the module and exercise its
// pure helpers/constants without standing up the provider.
import {
  getAvatarColor,
  MAIN_LABELS,
  SECONDARY_LABELS,
  DEFAULT_LABELS,
} from '../MailContext';
import { isSystemLabel } from '../../utils/label-utils';

// The avatar palette baked into MailContext (kept in sync for membership checks).
const AVATAR_COLORS = [
  '#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EF4444',
  '#06B6D4', '#EC4899', '#F97316', '#14B8A6', '#6366F1',
];

describe('MailContext', () => {
  describe('getAvatarColor', () => {
    it('returns a color from the avatar palette', () => {
      expect(AVATAR_COLORS).toContain(getAvatarColor('Ada Lovelace'));
    });

    it('is deterministic for the same name', () => {
      expect(getAvatarColor('Grace Hopper')).toBe(getAvatarColor('Grace Hopper'));
    });

    it('returns a valid #RRGGBB hex string', () => {
      expect(getAvatarColor('x')).toMatch(/^#[0-9A-F]{6}$/i);
    });

    it('handles an empty name without throwing', () => {
      expect(AVATAR_COLORS).toContain(getAvatarColor(''));
    });

    it('spreads different names across more than one palette color', () => {
      const names = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve', 'Frank', 'Grace', 'Heidi'];
      const colors = new Set(names.map(getAvatarColor));
      expect(colors.size).toBeGreaterThan(1);
    });
  });

  describe('default label sets', () => {
    it('MAIN_LABELS holds the four primary mailboxes in order', () => {
      expect(MAIN_LABELS.map((l) => l.slug)).toEqual(['INBOX', 'STARRED', 'SENT', 'DRAFTS']);
    });

    it('SECONDARY_LABELS holds the expected slugs in order', () => {
      expect(SECONDARY_LABELS.map((l) => l.slug)).toEqual([
        'SCHEDULED', 'SNOOZED', 'IMPORTANT', 'ALL', 'ARCHIVE', 'SPAM', 'TRASH',
      ]);
    });

    it('DEFAULT_LABELS is exactly MAIN followed by SECONDARY', () => {
      expect(DEFAULT_LABELS).toEqual([...MAIN_LABELS, ...SECONDARY_LABELS]);
      expect(DEFAULT_LABELS).toHaveLength(MAIN_LABELS.length + SECONDARY_LABELS.length);
    });

    it('every default label has a non-empty id, name and slug', () => {
      DEFAULT_LABELS.forEach((label) => {
        expect(label.id).toBeTruthy();
        expect(label.name).toBeTruthy();
        expect(label.slug).toBeTruthy();
      });
    });

    it('default label ids and slugs are unique', () => {
      const ids = DEFAULT_LABELS.map((l) => l.id);
      const slugs = DEFAULT_LABELS.map((l) => l.slug);
      expect(new Set(ids).size).toBe(ids.length);
      expect(new Set(slugs).size).toBe(slugs.length);
    });

    it('every default slug is recognized by label-utils as a system label', () => {
      // Cross-module invariant: the built-in mailboxes must all be system labels.
      DEFAULT_LABELS.forEach((label) => {
        expect(isSystemLabel(label.slug)).toBe(true);
      });
    });
  });
});
