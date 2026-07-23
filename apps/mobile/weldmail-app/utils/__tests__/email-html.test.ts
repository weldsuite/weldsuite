import { sanitizeEmailHtml, buildEmailDocument, trimTrailingEmptyHtml } from '../email-html';

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

describe('buildEmailDocument', () => {
  it('trims trailing empty nodes from the embedded body', () => {
    const doc = buildEmailDocument('<p>content</p><br><br>&nbsp;', { textColor: '#000' });
    expect(doc).toContain('<p>content</p></body>');
  });


  it('injects a restrictive CSP that blocks scripts by default', () => {
    const doc = buildEmailDocument('<p>ok</p>', { textColor: '#000' });
    expect(doc).toContain('Content-Security-Policy');
    expect(doc).toContain("default-src 'none'");
    // No script-src directive ⇒ scripts fall back to default-src 'none'.
    expect(doc).not.toMatch(/script-src/i);
  });

  it('embeds the sanitised (not raw) body', () => {
    const doc = buildEmailDocument('<script>bad()</script><p>good</p>', { textColor: '#111' });
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
    expect(buildEmailDocument('x', { textColor: '#000', hideQuotes: true })).toContain('.gmail_quote');
    expect(buildEmailDocument('x', { textColor: '#000', hideQuotes: false })).not.toContain('.gmail_quote');
  });
});
