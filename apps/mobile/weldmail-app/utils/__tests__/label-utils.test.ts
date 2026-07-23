import { getLabelColor, filterDisplayLabels, isSystemLabel } from '../label-utils';

// The exact palette baked into label-utils. Kept in sync with the source so we
// can assert palette membership without re-implementing the hash function.
const LABEL_COLORS = [
  '#EF4444', '#F97316', '#F59E0B', '#EAB308', '#84CC16',
  '#22C55E', '#10B981', '#14B8A6', '#06B6D4', '#0EA5E9',
  '#3B82F6', '#6366F1', '#8B5CF6', '#A855F7', '#D946EF',
  '#EC4899', '#F43F5E',
];

describe('label-utils', () => {
  describe('getLabelColor', () => {
    it('returns a color from the palette for an arbitrary label', () => {
      expect(LABEL_COLORS).toContain(getLabelColor('Work'));
    });

    it('is deterministic for the same label name', () => {
      expect(getLabelColor('Projects')).toBe(getLabelColor('Projects'));
    });

    it('returns a valid #RRGGBB hex string', () => {
      expect(getLabelColor('anything-here')).toMatch(/^#[0-9A-F]{6}$/i);
    });

    it('prefers an explicit hex override from the color map', () => {
      expect(getLabelColor('Work', { Work: '#123456' })).toBe('#123456');
    });

    it('ignores a color-map entry that is not a hex value', () => {
      // A non-hex mapped value falls back to the hashed palette color.
      expect(getLabelColor('Work', { Work: 'red' })).toBe(getLabelColor('Work'));
    });

    it('ignores a color-map entry that targets a different label', () => {
      expect(getLabelColor('Work', { Personal: '#123456' })).toBe(getLabelColor('Work'));
    });

    it('falls back to the palette when given an empty color map', () => {
      expect(getLabelColor('Work', {})).toBe(getLabelColor('Work'));
    });

    it('handles an empty label name without throwing', () => {
      expect(LABEL_COLORS).toContain(getLabelColor(''));
    });

    it('spreads many distinct labels across multiple palette colors', () => {
      const names = Array.from({ length: 40 }, (_, i) => `label-${i}`);
      const colors = new Set(names.map((n) => getLabelColor(n)));
      // A sane hash must not collapse 40 names into a single bucket.
      expect(colors.size).toBeGreaterThan(1);
    });
  });

  describe('filterDisplayLabels', () => {
    it('keeps mixed-case user labels', () => {
      expect(filterDisplayLabels(['Work', 'Personal'])).toEqual(['Work', 'Personal']);
    });

    it('drops all-uppercase system slugs', () => {
      expect(filterDisplayLabels(['INBOX', 'SENT', 'Work'])).toEqual(['Work']);
    });

    it('drops strings with no lowercase letters (uppercase-equivalent)', () => {
      // "123" === "123".toUpperCase(), so it is treated as a system-style slug.
      expect(filterDisplayLabels(['123', 'Work'])).toEqual(['Work']);
    });

    it('keeps a label that contains any lowercase character', () => {
      expect(filterDisplayLabels(['HELLOworld'])).toEqual(['HELLOworld']);
    });

    it('returns an empty array when given an empty array', () => {
      expect(filterDisplayLabels([])).toEqual([]);
    });

    it('does not mutate the input array', () => {
      const input = ['INBOX', 'Work'];
      filterDisplayLabels(input);
      expect(input).toEqual(['INBOX', 'Work']);
    });
  });

  describe('isSystemLabel', () => {
    const SYSTEM_SLUGS = [
      'INBOX', 'STARRED', 'SENT', 'DRAFTS', 'TRASH', 'SPAM', 'ARCHIVE',
      'SCHEDULED', 'SNOOZED', 'IMPORTANT', 'ALL', 'MUTED', 'UNREAD', 'DRAFT',
    ];

    it.each(SYSTEM_SLUGS)('recognizes %s as a system label', (slug) => {
      expect(isSystemLabel(slug)).toBe(true);
    });

    it('is case-insensitive', () => {
      expect(isSystemLabel('inbox')).toBe(true);
      expect(isSystemLabel('Inbox')).toBe(true);
      expect(isSystemLabel('iNbOx')).toBe(true);
    });

    it('returns false for custom user labels', () => {
      expect(isSystemLabel('Work')).toBe(false);
      expect(isSystemLabel('clients')).toBe(false);
    });

    it('returns false for an empty string', () => {
      expect(isSystemLabel('')).toBe(false);
    });
  });
});
