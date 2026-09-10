import {
  sanitizeEmailHtml,
  buildEmailDocument,
  trimTrailingEmptyHtml,
  unwrapEmailHtml,
  EMAIL_LAYOUT_PROBE,
  EMAIL_CANVAS_BG,
  EMAIL_CANVAS_TEXT,
  buildResponsiveEmailCss,
} from '../email-html';

describe('sanitizeEmailHtml', () => {
  it('removes <script> blocks and their content', () => {
    const out = sanitizeEmailHtml('<p>hi</p><script>alert(document.cookie)</script>');
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toContain('alert(document.cookie)');
    expect(out).toContain('<p>hi</p>');
  });

  it('strips inline event-handler attributes (onerror/onload/onclick)', () => {
    expect(sanitizeEmailHtml('<img src=x onerror="fetch(`//evil`)">')).not.toMatch(/onerror/i);
    expect(sanitizeEmailHtml('<body onload=steal()>')).not.toMatch(/onload/i);
    expect(sanitizeEmailHtml('<a onclick=\'x()\'>t</a>')).not.toMatch(/onclick/i);
  });

  it('neutralises javascript: and vbscript: URIs in href/src', () => {
    expect(sanitizeEmailHtml('<a href="javascript:alert(1)">x</a>')).not.toMatch(/javascript:/i);
    expect(sanitizeEmailHtml('<img src="vbscript:msgbox(1)">')).not.toMatch(/vbscript:/i);
  });

  it('neutralises data:text/html payloads', () => {
    expect(sanitizeEmailHtml('<a href="data:text/html,<script>x</script>">y</a>')).not.toMatch(
      /data:\s*text\/html/i,
    );
  });

  it('removes iframes, forms, objects and meta-refresh', () => {
    expect(sanitizeEmailHtml('<iframe src="https://evil"></iframe>')).not.toMatch(/<iframe/i);
    expect(sanitizeEmailHtml('<form action="https://evil"><input></form>')).not.toMatch(/<form|<input/i);
    expect(sanitizeEmailHtml('<object data="x"></object>')).not.toMatch(/<object/i);
    expect(sanitizeEmailHtml('<meta http-equiv="refresh" content="0;url=https://evil">')).not.toMatch(/<meta/i);
  });

  it('removes <svg> (a common onload XSS vector)', () => {
    expect(sanitizeEmailHtml('<svg onload=alert(1)></svg>')).not.toMatch(/<svg|onload/i);
  });

  it('preserves safe content and formatting', () => {
    const out = sanitizeEmailHtml(
      '<p style="color:red">Hello <b>world</b> <a href="https://example.com">link</a></p>',
    );
    expect(out).toContain('Hello');
    expect(out).toContain('<b>world</b>');
    expect(out).toContain('https://example.com');
  });

  it('handles empty / falsy input', () => {
    expect(sanitizeEmailHtml('')).toBe('');
    expect(sanitizeEmailHtml(undefined as unknown as string)).toBe('');
  });
});

describe('trimTrailingEmptyHtml', () => {
  it('removes trailing <br>, empty blocks, &nbsp; and whitespace', () => {
    expect(trimTrailingEmptyHtml('<p>Hi</p><br><br>')).toBe('<p>Hi</p>');
    expect(trimTrailingEmptyHtml('<p>Hi</p><div></div>')).toBe('<p>Hi</p>');
    expect(trimTrailingEmptyHtml('<p>Hi</p>&nbsp; \n')).toBe('<p>Hi</p>');
    expect(trimTrailingEmptyHtml('<p>Hi</p><o:p></o:p>')).toBe('<p>Hi</p>');
  });

  it('collapses nested empty trailers', () => {
    expect(trimTrailingEmptyHtml('<p>Hi</p><div><br></div>')).toBe('<p>Hi</p>');
    expect(trimTrailingEmptyHtml('<p>Hi</p><div>&nbsp;<br></div><br>')).toBe('<p>Hi</p>');
  });

  it('leaves non-empty trailing content untouched', () => {
    expect(trimTrailingEmptyHtml('<p>Hi</p><div>bye</div>')).toBe('<p>Hi</p><div>bye</div>');
    expect(trimTrailingEmptyHtml('<p>Hi</p>')).toBe('<p>Hi</p>');
  });

  it('handles empty / falsy input', () => {
    expect(trimTrailingEmptyHtml('')).toBe('');
    expect(trimTrailingEmptyHtml(undefined as unknown as string)).toBe('');
  });
});

describe('unwrapEmailHtml', () => {
  it('keeps head <style> blocks and body markup from a full document', () => {
    const out = unwrapEmailHtml(
      '<html><head><style>.x{color:red}</style><meta charset="utf-8"></head>' +
        '<body bgcolor="#f4f4f4" style="margin:0"><p class="x">Hi</p></body></html>',
    );
    expect(out).toContain('<style>.x{color:red}</style>');
    expect(out).toContain('<p class="x">Hi</p>');
    expect(out).toContain('bgcolor="#f4f4f4"');
    expect(out).toContain('style="margin:0"');
    expect(out).not.toContain('<meta');
  });

  it('returns fragments unchanged', () => {
    expect(unwrapEmailHtml('<p>Hi</p>')).toBe('<p>Hi</p>');
  });
});

describe('buildEmailDocument', () => {
  it('trims trailing empty nodes from the embedded body', () => {
    const doc = buildEmailDocument('<p>content</p><br><br>&nbsp;');
    expect(doc).toContain('<p>content</p></body>');
  });

  it('defaults to a light reading-pane canvas (never theme-inverted)', () => {
    const doc = buildEmailDocument('<p>ok</p>');
    expect(doc).toContain(`background:${EMAIL_CANVAS_BG}`);
    expect(doc).toContain(`color:${EMAIL_CANVAS_TEXT}`);
    expect(doc).toContain('color-scheme:light only');
    expect(doc).toContain('name="color-scheme" content="light only"');
  });

  it('injects a restrictive CSP that blocks scripts by default', () => {
    const doc = buildEmailDocument('<p>ok</p>');
    expect(doc).toContain('Content-Security-Policy');
    expect(doc).toContain("default-src 'none'");
    // No script-src directive ⇒ scripts fall back to default-src 'none'.
    expect(doc).not.toMatch(/script-src/i);
  });

  it('embeds the sanitised (not raw) body', () => {
    const doc = buildEmailDocument('<script>bad()</script><p>good</p>');
    expect(doc).not.toMatch(/<script>bad/);
    expect(doc).toContain('<p>good</p>');
  });

  it('applies the requested text color, font size and line height', () => {
    const doc = buildEmailDocument('x', { textColor: '#abcdef', fontSize: 18, lineHeight: 2 });
    expect(doc).toContain('color:#abcdef');
    expect(doc).toContain('font-size:18px');
    expect(doc).toContain('line-height:2');
  });

  it('hides quoted blocks only when hideQuotes is set', () => {
    expect(buildEmailDocument('x', { hideQuotes: true })).toContain('.gmail_quote');
    expect(buildEmailDocument('x', { hideQuotes: false })).not.toContain('.gmail_quote');
  });

  it('ships responsive rules so fixed-width ESP tables fit the phone viewport', () => {
    const doc = buildEmailDocument(
      '<table width="600" style="width:600px;min-width:600px"><tr><td>Hello</td></tr></table>',
    );
    expect(doc).toContain('overflow-x:auto');
    expect(doc).toContain('max-width:100%');
    expect(doc).toContain('min-width:0 !important');
    // Must NOT force width:100%/table-layout:fixed — that collapses nested ESP bodies.
    expect(doc).not.toContain('table-layout:fixed');
    expect(doc).not.toMatch(/table\{width:100% !important/);
    expect(doc).toContain('overflow-wrap:anywhere');
    expect(doc).toContain('width=device-width');
    expect(doc).toContain('user-scalable=no');
    // Body still contains the original markup (clamping happens at render time).
    expect(doc).toContain('width="600"');
  });
});

describe('EMAIL_LAYOUT_PROBE', () => {
  it('rewrites oversized widths and reports height without transform scaling', () => {
    expect(EMAIL_LAYOUT_PROBE).toContain('fitToViewport');
    expect(EMAIL_LAYOUT_PROBE).toContain("setAttribute('width', '100%')");
    expect(EMAIL_LAYOUT_PROBE).toContain('min-width');
    expect(EMAIL_LAYOUT_PROBE).toContain('max >= 120');
    expect(EMAIL_LAYOUT_PROBE).not.toContain('data-fit-scale');
    expect(EMAIL_LAYOUT_PROBE).not.toMatch(/transform.*scale/);
    expect(EMAIL_LAYOUT_PROBE).toContain('ReactNativeWebView');
  });
});

describe('buildResponsiveEmailCss', () => {
  it('caps tables, images and long words to the viewport without collapsing layout', () => {
    const css = buildResponsiveEmailCss({
      textColor: '#111',
      backgroundColor: '#ffffff',
      fontSize: 15,
      lineHeight: 1.6,
      hideQuotes: false,
    });
    expect(css).toContain('overflow-x:auto');
    expect(css).toContain('min-width:0 !important');
    expect(css).toContain('max-width:100% !important');
    expect(css).toContain('background:#ffffff');
    expect(css).toContain('color-scheme:light only');
    expect(css).not.toContain('table-layout:fixed');
    expect(css).not.toMatch(/table\{width:100% !important/);
    expect(css).toContain('img,video{max-width:100% !important;height:auto !important;}');
    expect(css).toContain('overflow-wrap:anywhere');
  });
});
