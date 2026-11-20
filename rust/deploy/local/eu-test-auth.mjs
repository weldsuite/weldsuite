// Sign in to the local stack with your EU test account (README.md, "Sign in
// with your EU test account"). The server then takes EU test's Zitadel tokens
// instead of mint-token.mjs's, and the local workspace `ws_local` answers to
// your EU test organization, with you as its owner. Nothing changes on EU
// test: its Zitadel only issues the tokens.
//
//   node eu-test-auth.mjs --client-id <id> --token <access token>
//   node eu-test-auth.mjs --client-id <id> --user <id> --org <id> --email <address>
//                         [--first-name <name>] [--last-name <name>]
//   node eu-test-auth.mjs --off
//
// --client-id  the localhost application in EU test's Zitadel (README.md),
//              which `dev:eu` takes as EU_DEV_CLIENT_ID: that variable works
//              here too. Remembered, so later runs may leave it out.
// --token      an EU test access token of yours: your user id, organization
//              and profile are read from it (the token itself is not kept).
// --org        with several EU test workspaces, the one to use.
// --off        back to mint-token.mjs's tokens (Postman).
// --config     where the issuer and project come from (default EU test's
//              https://app.test.weldsuite.eu/config.json).
// --no-up      only write .local/auth.env; `docker compose up -d` applies it.
//
// Writes .local/auth.env (git-ignored), which compose.yaml hands the server
// (AUTH_PROVIDER, OIDC_*) and the seeds (LOCAL_*, seed/master.sql), then
// runs `docker compose up -d`, which re-runs the seeds and restarts the server.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const authEnvPath = path.join(here, '.local', 'auth.env');
const DEFAULT_CONFIG = 'https://app.test.weldsuite.eu/config.json';
const SERVER = 'http://localhost:8080';

function fail(message) {
  console.error(`eu-test-auth: ${message}`);
  process.exit(1);
}

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      'client-id': { type: 'string' },
      token: { type: 'string' },
      user: { type: 'string' },
      org: { type: 'string' },
      email: { type: 'string' },
      'first-name': { type: 'string' },
      'last-name': { type: 'string' },
      config: { type: 'string', default: DEFAULT_CONFIG },
      off: { type: 'boolean', default: false },
      'no-up': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  }));
} catch (error) {
  fail(`${error.message} (--help for usage)`);
}

if (args.help) {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  console.log(source.split('\nimport ')[0].replace(/^\/\/ ?/gm, ''));
  process.exit(0);
}

/** The previous run's values, so --client-id need not be repeated. */
function readAuthEnv() {
  if (!existsSync(authEnvPath)) return {};
  const values = {};
  for (const line of readFileSync(authEnvPath, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    if (match) values[match[1]] = match[2].replace(/^'(.*)'$/, '$1');
  }
  return values;
}

/** `docker compose up -d` here: re-runs the seeds and recreates the server. */
function composeUp() {
  if (args['no-up']) {
    console.log('Run `docker compose up -d` here to apply it.');
    return false;
  }
  console.log('\n$ docker compose up -d');
  const result = spawnSync('docker', ['compose', 'up', '-d'], { cwd: here, stdio: 'inherit' });
  if (result.error) fail(`docker: ${result.error.message}`);
  if (result.status !== 0) fail('`docker compose up -d` failed (above). Fix it and run it again.');
  return true;
}

/** The server's /config.json once it answers, or null after a minute. */
async function serverConfig() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const ready = await fetch(`${SERVER}/readyz`);
      if (ready.ok) return await (await fetch(`${SERVER}/config.json`)).json();
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return null;
}

if (args.off) {
  rmSync(authEnvPath, { force: true });
  console.log(`Removed ${authEnvPath}: the server takes mint-token.mjs's tokens again.`);
  if (composeUp()) {
    const config = await serverConfig();
    console.log(config ? `Ready on ${SERVER}.` : 'The server did not answer within a minute: `docker compose logs weldsuite`.');
  }
  process.exit(0);
}

// 1. Where EU test signs people in: its issuer, project and roles claim.
let auth;
try {
  const response = await fetch(args.config);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  auth = (await response.json()).auth;
} catch (error) {
  fail(`cannot read ${args.config}: ${error.message}`);
}
if (auth?.provider !== 'oidc' || !auth.issuer || !auth.audience) {
  fail(`${args.config} names no OIDC provider`);
}
const issuer = auth.issuer.replace(/\/+$/, '');
const orgClaim = auth.orgClaim ?? `urn:zitadel:iam:org:project:${auth.audience}:roles`;

const previous = readAuthEnv();
const clientId = args['client-id'] ?? (process.env.EU_DEV_CLIENT_ID?.trim() || previous.OIDC_WEB_CLIENT_ID);
if (!clientId) {
  fail(
    '--client-id (or EU_DEV_CLIENT_ID) is required: the client id of the localhost application in EU test\'s Zitadel ' +
      '(README.md, "Sign in with your EU test account").',
  );
}

// 2. Who you are: from the token, or from the flags (which win).
let fromToken = {};
if (args.token) {
  const parts = args.token.trim().split('.');
  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'));
  } catch {
    fail('--token is not a JWT: copy the access token (README.md has a snippet for it)');
  }
  if (claims.iss !== issuer) fail(`the token is from ${claims.iss}, not ${issuer}`);
  // The organizations, as the server reads the roles claim
  // (`weldsuite_auth::oidc::organization`): { role: { orgId: domain } }.
  const organizations = new Map();
  const value = claims[orgClaim];
  if (typeof value === 'string') organizations.set(value, value);
  else if (Array.isArray(value)) value.filter((id) => typeof id === 'string').forEach((id) => organizations.set(id, id));
  else if (value && typeof value === 'object') {
    for (const grants of Object.values(value)) {
      for (const [id, domain] of Object.entries(grants ?? {})) organizations.set(id, String(domain));
    }
  }
  let org = args.org;
  if (!org) {
    if (organizations.size === 1) [org] = organizations.keys();
    else if (organizations.size === 0) {
      fail(`the token names no organization (${orgClaim}): pass --org <your EU test organization id>`);
    } else {
      const list = [...organizations].map(([id, domain]) => `  --org ${id}   (${domain})`).join('\n');
      fail(`you are in ${organizations.size} EU test workspaces; pick one:\n${list}`);
    }
  }
  fromToken = { user: claims.sub, org, email: claims.email, first: claims.given_name, last: claims.family_name };

  // The profile, which an access token doesn't carry.
  try {
    const discovery = await (await fetch(`${issuer}/.well-known/openid-configuration`)).json();
    const response = await fetch(discovery.userinfo_endpoint, {
      headers: { Authorization: `Bearer ${args.token.trim()}` },
    });
    if (response.ok) {
      const info = await response.json();
      fromToken.email ??= info.email;
      fromToken.first ??= info.given_name;
      fromToken.last ??= info.family_name;
    } else {
      console.warn(`eu-test-auth: userinfo answered ${response.status} (an expired token?); pass --email`);
    }
  } catch (error) {
    console.warn(`eu-test-auth: userinfo: ${error.message}`);
  }
}

const person = {
  user: args.user ?? fromToken.user ?? previous.LOCAL_USER_ID,
  org: args.org ?? fromToken.org ?? previous.LOCAL_ORG_ID,
  email: args.email ?? fromToken.email ?? previous.LOCAL_USER_EMAIL,
  first: args['first-name'] ?? fromToken.first ?? previous.LOCAL_USER_FIRST_NAME ?? '',
  last: args['last-name'] ?? fromToken.last ?? previous.LOCAL_USER_LAST_NAME ?? '',
};
const missing = [
  !person.user && '--user (your Zitadel user id)',
  !person.org && '--org (your EU test organization id)',
  !person.email && '--email',
].filter(Boolean);
if (missing.length > 0) fail(`missing ${missing.join(', ')}; or pass --token`);

// 3. .local/auth.env. Single quotes: compose takes the value as it is (no
// `$` expansion); a value can't hold one itself, nor a line break.
const quote = (value) => `'${String(value).replace(/[\r\n]+/g, ' ').replace(/'/g, '’')}'`;
const lines = [
  `# Written by eu-test-auth.mjs on ${new Date().toISOString()}: sign-in through`,
  `# EU test's Zitadel. \`node eu-test-auth.mjs --off\` goes back to mint-token.mjs.`,
  'AUTH_PROVIDER=oidc',
  `OIDC_ISSUER=${quote(issuer)}`,
  `OIDC_AUDIENCE=${quote(auth.audience)}`,
  `OIDC_ORG_CLAIM=${quote(orgClaim)}`,
  `OIDC_WEB_CLIENT_ID=${quote(clientId)}`,
  `LOCAL_ORG_ID=${quote(person.org)}`,
  `LOCAL_USER_ID=${quote(person.user)}`,
  `LOCAL_USER_EMAIL=${quote(person.email)}`,
  `LOCAL_USER_FIRST_NAME=${quote(person.first)}`,
  `LOCAL_USER_LAST_NAME=${quote(person.last)}`,
  '',
];
mkdirSync(path.dirname(authEnvPath), { recursive: true });
writeFileSync(authEnvPath, lines.join('\n'));
const name = `${person.first} ${person.last}`.trim();
console.log(`Wrote ${authEnvPath}:`);
console.log(`  issuer        ${issuer} (project ${auth.audience})`);
console.log(`  client        ${clientId}`);
console.log(`  you           ${person.user}${name ? ` (${name}, ${person.email})` : ` (${person.email})`}`);
console.log(`  organization  ${person.org} -> ws_local`);

// 4. Apply it, and check the server now names EU test as its provider.
if (composeUp()) {
  const config = await serverConfig();
  if (!config) fail('the server did not answer within a minute: `docker compose logs weldsuite`');
  if (config.auth?.provider !== 'oidc') {
    fail(`${SERVER}/config.json names no OIDC provider: is .local/auth.env in compose.yaml (env_file)?`);
  }
  console.log(`\nReady: ${SERVER} takes EU test tokens. Start the platform against it (README.md, "The platform").`);
}
