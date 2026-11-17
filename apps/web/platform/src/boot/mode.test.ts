import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootMode, withoutGoogleFonts } from './mode';

describe('bootMode', () => {
  it('is runtime only for "on"', () => {
    expect(bootMode(' ON ')).toBe('runtime');
    expect(bootMode('off')).toBe('global');
    expect(bootMode(undefined)).toBe('global');
  });
});

describe('withoutGoogleFonts', () => {
  const indexHtml = readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8');

  it("drops the platform's Google Fonts stylesheet and preconnects, nothing else", () => {
    expect(indexHtml).toContain('fonts.googleapis.com');
    const stripped = withoutGoogleFonts(indexHtml);
    expect(stripped).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    expect(stripped).toContain('<link rel="icon" href="/favicon.ico" />');
    expect(stripped).toContain('<script src="/__ENV.js"></script>');
    expect(stripped.split('\n')).toHaveLength(indexHtml.split('\n').length - 3);
  });

  it('leaves a page without Google Fonts alone', () => {
    const html = '<head>\n  <link rel="stylesheet" href="/app.css" />\n</head>\n';
    expect(withoutGoogleFonts(html)).toBe(html);
  });
});
