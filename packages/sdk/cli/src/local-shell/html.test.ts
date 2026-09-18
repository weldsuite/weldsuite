import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderLocalShellHtml } from './html.js';

describe('renderLocalShellHtml', () => {
  it('embeds app url/code/name and localPreview init flag', () => {
    const html = renderLocalShellHtml({
      appUrl: 'http://localhost:5173/',
      appCode: 'my-app',
      appName: 'My App',
    });
    assert.match(html, /http:\/\/localhost:5173\//);
    assert.match(html, /my-app/);
    assert.match(html, /My App/);
    assert.match(html, /localPreview:\s*true/);
    assert.match(html, /weldapp:ready/);
    assert.match(html, /weldapp:init/);
    assert.match(html, /Local shell/);
  });

  it('escapes HTML in the title/name', () => {
    const html = renderLocalShellHtml({
      appUrl: 'http://localhost:5173/',
      appCode: 'x',
      appName: `A <script>alert(1)</script>`,
    });
    // Attribute / title contexts must be entity-escaped (JS string may still
    // contain the raw text via JSON.stringify — that is intentional).
    assert.match(html, /<title>A &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /title="A &lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
  });
});
