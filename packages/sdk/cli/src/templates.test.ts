import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { copyTemplateDir, substitute, templatesRoot } from './templates.js';

test('substitute replaces known placeholders only', () => {
  assert.equal(substitute('Hello {{APP_NAME}}', { APP_NAME: 'Acme' }), 'Hello Acme');
  assert.equal(substitute('{{UNKNOWN}}', {}), '{{UNKNOWN}}');
});

test('app scaffold renames _github to .github and includes deploy workflow', async () => {
  const dest = await mkdtemp(join(tmpdir(), 'weld-cli-scaffold-'));
  try {
    const written = await copyTemplateDir(join(templatesRoot(), 'app'), dest, {
      APP_NAME: 'CI Demo',
      APP_CODE: 'ci-demo',
    });
    assert.ok(written.includes('.github/workflows/deploy-weld-app.yml'));
    assert.ok(!written.some((path) => path.startsWith('_github/')));

    const workflow = await readFile(join(dest, '.github/workflows/deploy-weld-app.yml'), 'utf8');
    assert.match(workflow, /weld app deploy/);
    assert.match(workflow, /WELD_API_KEY/);
    assert.match(workflow, /user-apps:manage/);
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
});
