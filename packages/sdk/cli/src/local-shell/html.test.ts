import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Script } from 'node:vm';
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

  it('emits an inline script that parses (template-literal escapes intact)', () => {
    const html = renderLocalShellHtml({ appUrl: 'http://localhost:5173/', appCode: 'x', appName: 'X' });
    const match = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(match, 'inline script present');
    assert.doesNotThrow(() => new Script(match[1] ?? ''));
  });

  it('speaks bridge protocol 2 without handing the app a token', () => {
    const html = renderLocalShellHtml({ appUrl: 'http://localhost:5173/', appCode: 'x', appName: 'X' });
    assert.match(html, /const PROTOCOL = 2;/);
    assert.match(html, /token: null,/);
    for (const method of ['fetch', 'setBreadcrumbs', 'setDirty', 'confirm', 'openModal', 'closeModal']) {
      assert.match(html, new RegExp(`method === '${method}'`));
    }
  });

  it('cannot be broken out of the inline script by the app name', () => {
    const html = renderLocalShellHtml({
      appUrl: 'http://localhost:5173/',
      appCode: 'x',
      appName: 'A</script><script>alert(1)</script>',
    });
    const script = html.slice(html.indexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
    assert.doesNotMatch(script, /<\/script>/);
  });
});
