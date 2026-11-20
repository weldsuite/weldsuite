import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EMBED_CONFIG,
  buildEmbedQuery,
  buildEmbedSnippet,
  buildEmbedUrl,
  buildPrefillUrl,
  cleanHidden,
  portalOrigin,
  qrTarget,
  type EmbedConfig,
} from './embed-snippet';

const ORIGIN = 'https://forms.weldsuite.org';
const config = (patch: Partial<EmbedConfig>): EmbedConfig => ({ ...DEFAULT_EMBED_CONFIG, ...patch });

describe('portalOrigin', () => {
  it('takes the origin of the public link', () => {
    expect(portalOrigin('https://forms.weldsuite.org/f/abc123')).toBe(ORIGIN);
  });
  it('is null without a usable link', () => {
    expect(portalOrigin(null)).toBeNull();
    expect(portalOrigin('not a url')).toBeNull();
  });
});

describe('cleanHidden', () => {
  it('drops invalid and duplicate names', () => {
    expect(
      cleanHidden([
        { name: 'utm_source', value: 'x' },
        { name: '1bad', value: 'y' },
        { name: 'utm_source', value: 'z' },
        { name: ' plan ', value: 'pro' },
      ]),
    ).toEqual([
      { name: 'utm_source', value: 'x' },
      { name: 'plan', value: 'pro' },
    ]);
  });
});

describe('buildEmbedSnippet', () => {
  it('renders an inline container with auto height', () => {
    expect(buildEmbedSnippet(ORIGIN, 'abc', config({}))).toBe(
      `<div data-wf="abc" data-wf-mode="inline" data-wf-height="auto"></div>\n<script async src="${ORIGIN}/embed.js"></script>`,
    );
  });

  it('uses a fixed height when auto height is off', () => {
    expect(buildEmbedSnippet(ORIGIN, 'abc', config({ autoHeight: false, height: 480 }))).toContain('data-wf-height="480"');
  });

  it('renders a popup as a button that opens on click', () => {
    const snippet = buildEmbedSnippet(ORIGIN, 'abc', config({ mode: 'popup', size: 'large', buttonText: 'Feedback <now>' }));
    expect(snippet).toContain('<button type="button" data-wf="abc" data-wf-mode="popup" data-wf-size="large" data-wf-open="click"');
    expect(snippet).toContain('>Feedback &lt;now&gt;</button>');
  });

  it('opens a slider without a button on a scroll depth', () => {
    const snippet = buildEmbedSnippet(ORIGIN, 'abc', config({ mode: 'slider', trigger: 'scroll', scrollPercent: 70 }));
    expect(snippet).toContain('data-wf-open="scroll:70"');
    expect(snippet).toMatch(/^<div /);
  });

  it('renders a popover with its colour and text', () => {
    const snippet = buildEmbedSnippet(ORIGIN, 'abc', config({ mode: 'popover', buttonColor: '#ff0000', buttonText: 'Help' }));
    expect(snippet).toContain('data-wf-button-color="#ff0000"');
    expect(snippet).toContain('>Help</div>');
  });

  it('carries hidden fields and escapes attribute values', () => {
    const snippet = buildEmbedSnippet(ORIGIN, 'abc', config({ hidden: [{ name: 'ref', value: 'a"b&c' }], hideAfterSubmit: true }));
    expect(snippet).toContain('data-wf-hidden="ref=a%22b%26c"');
    expect(snippet).toContain('data-wf-hide-after-submit="true"');
  });
});

describe('buildEmbedUrl', () => {
  it('names the mode and passes hidden fields as plain parameters', () => {
    const c = config({ mode: 'popup', hidden: [{ name: 'campaign', value: 'spring sale' }] });
    expect(buildEmbedQuery(c)).toBe('embed=popup&campaign=spring+sale');
    expect(buildEmbedUrl(ORIGIN, 'abc', c)).toBe(`${ORIGIN}/f/abc?embed=popup&campaign=spring+sale`);
  });
});

describe('buildPrefillUrl', () => {
  it('appends parameters and leaves the link alone without any', () => {
    expect(buildPrefillUrl(`${ORIGIN}/f/abc`, [])).toBe(`${ORIGIN}/f/abc`);
    expect(buildPrefillUrl(`${ORIGIN}/f/abc`, [{ name: 'email', value: 'a@b.nl' }])).toBe(`${ORIGIN}/f/abc?email=a%40b.nl`);
    expect(buildPrefillUrl(`${ORIGIN}/f/abc?x=1`, [{ name: 'y', value: '2' }])).toBe(`${ORIGIN}/f/abc?x=1&y=2`);
  });
  it('tags the QR target with its source', () => {
    expect(qrTarget(`${ORIGIN}/f/abc`)).toBe(`${ORIGIN}/f/abc?source=qr`);
  });
});
