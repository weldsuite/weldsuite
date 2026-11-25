import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CliError } from '../errors.js';
import { checkBundle, deployUrl, describeError, uploadable, withoutTrailingSlashes } from './storefront-deploy.js';

const file = (path: string, size = 10) => ({ path, bytes: Buffer.alloc(size) });

describe('weld storefront deploy', () => {
  it('leaves hidden files out but keeps .well-known', () => {
    assert.equal(uploadable('index.html'), true);
    assert.equal(uploadable('.well-known/security.txt'), true);
    assert.equal(uploadable('.git/config'), false);
    assert.equal(uploadable('assets/.DS_Store'), false);
  });

  it('builds the deploy URL', () => {
    assert.equal(deployUrl('https://app.weldsuite.eu/', false), 'https://app.weldsuite.eu/storefront-deploy/v1/deployments');
    assert.equal(
      deployUrl('https://app.weldsuite.eu', true),
      'https://app.weldsuite.eu/storefront-deploy/v1/deployments?production=true',
    );
    assert.throws(() => deployUrl('app.weldsuite.eu', false), CliError);
  });

  it('trims trailing slashes as the regular expression it replaced did', () => {
    const before = (value: string) => value.replace(/\/+$/, '');
    for (const value of ['', '/', '///', 'https://app.weldsuite.eu', 'https://app.weldsuite.eu/', 'https://app.weldsuite.eu///', 'https://a.example/x/', '/a', 'a//b', 'a/ ', 'a/ /', 'a/\n']) {
      assert.equal(withoutTrailingSlashes(value), before(value), JSON.stringify(value));
    }
    assert.equal(withoutTrailingSlashes('https://app.weldsuite.eu//'), 'https://app.weldsuite.eu');
    assert.equal(deployUrl('  https://app.weldsuite.eu//  ', false), 'https://app.weldsuite.eu/storefront-deploy/v1/deployments');
    assert.throws(() => deployUrl('///', false), CliError);
  });

  it('checks the bundle before uploading', () => {
    assert.doesNotThrow(() => checkBundle([file('index.html')]));
    assert.throws(() => checkBundle([]), CliError);
    assert.throws(() => checkBundle([file('app.html')]), /index\.html/);
    assert.throws(() => checkBundle([file('index.html'), file('big.mp4', 26 * 1024 * 1024)]), /25 MiB/);
  });

  it('describes the server\'s refusals', () => {
    const message = describeError(400, {
      error: { code: 'VALIDATION_ERROR', message: 'The request is not valid', details: { fields: { 'config.spa': 'Must be true or false' } } },
    });
    assert.match(message, /VALIDATION_ERROR/);
    assert.match(message, /config\.spa: Must be true or false/);
    assert.equal(describeError(502, null), 'The server answered 502.');
  });
});
