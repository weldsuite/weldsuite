// Writes the cross-backend fixtures in rust/modules/pass/tests/fixtures/ from
// pass-api's own TypeScript code, so the Rust port is checked against what
// the worker really does rather than against a reading of it:
//
//   envelope-ts.json  KEKs, rewrapped KEKs, secrets (with their keyed
//                     checksums, lengths and hints) and items, sealed by
//                     envelope.ts with fixed root keys and its own randomness
//   totp-ts.json      parseTotp results and errors, and totpCode at fixed times
//   cases-ts.json     slugify, hostOf, hostsMatch, password strength, .env
//                     parsing and rendering, CSV import, and Zod's issues for
//                     the request bodies the routes validate
//
// The Rust tests (src/envelope.rs, src/totp.rs, src/cases.rs) open, recompute
// and compare. envelope-rust.json goes the other way: written by the Rust
// tests, opened by pass-api's envelope.vectors.test.ts.
//
//   pnpm exec tsx rust/modules/pass/tools/fixtures.mts
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const out = path.join(repo, 'rust/modules/pass/tests/fixtures');
const service = (name: string) =>
  pathToFileURL(path.join(repo, 'apps/workers/pass-api/src/services/weldpass', name)).href;
const route = (name: string) =>
  pathToFileURL(path.join(repo, 'apps/workers/pass-api/src/routes/weldpass', name)).href;

const envelope = (await import(service('envelope.ts'))) as typeof import('../../../../apps/workers/pass-api/src/services/weldpass/envelope');
const totp = (await import(service('totp.ts'))) as typeof import('../../../../apps/workers/pass-api/src/services/weldpass/totp');
const dotenv = (await import(service('dotenv.ts'))) as typeof import('../../../../apps/workers/pass-api/src/services/weldpass/dotenv');
const vault = (await import(service('vault.ts'))) as typeof import('../../../../apps/workers/pass-api/src/services/weldpass/vault');
const importer = (await import(service('password-import.ts'))) as typeof import('../../../../apps/workers/pass-api/src/services/weldpass/password-import');
const syncConfig = (await import(route('sync-config.ts'))) as typeof import('../../../../apps/workers/pass-api/src/routes/weldpass/sync-config');
const schemas = (await import(
  pathToFileURL(path.join(repo, 'packages/clients/app-api-client/src/schemas/weldpass-passwords.ts')).href
)) as typeof import('../../../../packages/clients/app-api-client/src/schemas/weldpass-passwords');
const { z } = createRequire(path.join(repo, 'apps/workers/pass-api/package.json'))('zod') as typeof import('zod');

mkdirSync(out, { recursive: true });
const write = (name: string, value: unknown) =>
  writeFileSync(path.join(out, name), `${JSON.stringify(value, null, 2)}\n`);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

// ── envelope ────────────────────────────────────────────────────────────────

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const KEY_C = '0123456789abcdef'.repeat(4);

const vaultKeys = [];
const rewrapped = [];
const secrets = [];
const items = [];
for (const [ownerId, keyring] of [
  ['wpp_ts_1', { v1: KEY_A }],
  ['wpp_ts_2', { v1: KEY_A, v2: KEY_B }],
  ['wpk_ts_1', { v1: KEY_C }],
] as const) {
  const wrapped = await envelope.createVaultKey(keyring, ownerId);
  const kek = await envelope.unwrapVaultKey(keyring, ownerId, wrapped.kekWrapped);
  vaultKeys.push({ ownerId, keyring, kekWrapped: wrapped.kekWrapped, rootKeyVersion: wrapped.rootKeyVersion, kekHex: hex(kek) });

  const rotation = { v1: keyring.v1 ?? KEY_A, v2: KEY_B };
  const rotated = await envelope.rewrapVaultKey({ ...keyring, ...rotation }, ownerId, wrapped.kekWrapped);
  rewrapped.push({ ownerId, keyring: { v2: KEY_B }, kekWrapped: rotated.kekWrapped, kekHex: hex(kek) });

  if (ownerId.startsWith('wpp')) {
    for (const [environmentId, key, plaintext] of [
      ['wpe_ts_1', 'DATABASE_URL', 'postgres://u:p@h/db'],
      ['wpe_ts_1', 'SHORT', 'short'],
      ['wpe_ts_2', 'EMPTY', ''],
      ['wpe_ts_2', 'UNICODE', 'pässwörd-😀-12345'],
      ['wpe_ts_2', 'SURROGATE_HINT', 'abcdefghijk😀'],
      ['wpe_ts_3', 'MULTILINE', 'line one\nline two\r\n\ttabbed "quoted" \\ backslash'],
    ]) {
      const location = { projectId: ownerId, environmentId, key };
      const sealed = await envelope.sealSecret(kek, location, plaintext);
      secrets.push({ kekHex: hex(kek), location, plaintext, ...sealed });
    }
    const credential = envelope.credentialLocation(ownerId, 'wpc_ts_1');
    const token = await envelope.sealSecret(kek, credential, 'cf-api-token-value');
    secrets.push({ kekHex: hex(kek), location: credential, plaintext: 'cf-api-token-value', ...token });
  } else {
    for (const [itemId, document] of [
      ['wpi_ts_1', { type: 'login', title: 'GitHub', url: 'https://github.com', fields: { username: 'carol', password: 'hunter2', totp: '', notes: '' } }],
      ['wpi_ts_2', { type: 'card', title: 'Visa', fields: { cardholder: 'Carol', number: '4111 1111 1111 4242', expiry: '08/29', cvc: '123', notes: '' } }],
      ['wpi_ts_3', { type: 'note', title: 'Ünïcode 😀', fields: { content: 'line one\nline two' } }],
    ] as const) {
      const location = { vaultId: ownerId, itemId };
      const plaintext = JSON.stringify(document);
      const sealed = await envelope.sealItem(kek, location, plaintext);
      items.push({ kekHex: hex(kek), location, plaintext, ...sealed });
    }
  }
}
const sha256 = [];
for (const input of ['', 'value', 'hunter2', 'pässwörd-😀']) {
  sha256.push({ input, hex: await envelope.sha256Hex(input) });
}
write('envelope-ts.json', {
  $comment: 'Sealed by apps/workers/pass-api/src/services/weldpass/envelope.ts (tools/fixtures.mts); opened by rust/modules/pass/src/envelope.rs.',
  vaultKeys,
  rewrapped,
  secrets,
  items,
  sha256,
});

// ── TOTP ────────────────────────────────────────────────────────────────────

const ascii = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let buffer = 0;
  let encoded = '';
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      encoded += alphabet[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) encoded += alphabet[(buffer << (5 - bits)) & 31];
  return encoded;
};
const rfcSha1 = ascii('12345678901234567890');
const rfcSha256 = ascii('12345678901234567890123456789012');
const rfcSha512 = ascii('1234567890123456789012345678901234567890123456789012345678901234');

const totpInputs = [
  'JBSWY3DPEHPK3PXP',
  ' jbsw y3dp-ehpk 3pxp== ',
  `otpauth://totp/RFC:sha1?secret=${rfcSha1}&digits=8`,
  `otpauth://totp/RFC:sha256?secret=${rfcSha256}&digits=8&algorithm=SHA256`,
  `otpauth://totp/RFC:sha512?secret=${rfcSha512}&digits=8&algorithm=sha512`,
  'OTPAUTH://TOTP/Acme:carol?secret=JBSWY3DPEHPK3PXP&issuer=Acme&period=60',
  'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=7abc&period= 45',
  'otpauth://totp/x?secret=jbsw%20y3dp&secret=AAAA',
  'otpauth://totp/x?secret=JBSW+Y3DP',
  'ıııı',
  '',
  '   ',
  'not base32 !!!',
  'A',
  '====',
  'otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP',
  'otpauth://totp/x',
  'otpauth://totp/x?secret=',
  'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=5',
  'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=9',
  'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=x',
  'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=4',
  'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=301',
  'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=MD5',
  'otpauth://totp/x?secret=JBSW1',
  'otpauth://[bad',
  'otpauth:///path-only?secret=JBSW',
];
const times = [59, 1111111109, 1111111111, 1234567890, 2000000000, 20000000000, 1761696000];
const parses = [];
for (const input of totpInputs) {
  try {
    const config = totp.parseTotp(input);
    const codes = [];
    for (const seconds of times) {
      const code = await totp.totpCode(config, new Date(seconds * 1000));
      codes.push({ seconds, code: code.code, period: code.period, expiresAt: code.expiresAt.toISOString() });
    }
    parses.push({ input, secretHex: hex(config.secret), digits: config.digits, period: config.period, algorithm: config.algorithm, codes });
  } catch (err) {
    parses.push({ input, error: (err as Error).message });
  }
}
write('totp-ts.json', {
  $comment: 'parseTotp and totpCode from apps/workers/pass-api/src/services/weldpass/totp.ts (tools/fixtures.mts); checked by rust/modules/pass/src/totp.rs.',
  cases: parses,
});

// ── pure helpers ────────────────────────────────────────────────────────────

const slugify = [
  'Hello World',
  '  --Weird__Name--  ',
  'Ünïcode Straße',
  'İstanbul',
  'a'.repeat(50),
  `${'a'.repeat(39)} b`,
  '---',
  '',
  'ABC-def-',
  'x-',
  '-x',
  'already-a-slug',
  '日本語',
  'A&B (beta) 2.0',
].map((input) => ({ input, output: vault.slugify(input) }));

const hostOf = [
  'https://example.com/login',
  'example.com/login',
  'https://www.Example.COM:8443/x',
  'www.example.com',
  'http://localhost:3000',
  'localhost',
  'ftp://example.com',
  'mailto:carol@example.com',
  'javascript:alert(1)',
  'not a url',
  'intranet',
  '  https://app.acme-match.test  ',
  'https://münchen.de',
  'https://[::1]:8080/',
  'http://127.0.0.1/',
  'http://0x7f.1/',
  'https://user:pw@sub.example.org/path',
  'HTTPS://WWW.WWW.EXAMPLE.COM',
  'custom+scheme://example.com',
  'https://exa mple.com',
  'https://example.com.',
  `https://${'a'.repeat(250)}.com`,
  '',
  '   ',
  'www.',
  'https://xn--mnchen-3ya.de/',
  'https://ex%41mple.com',
].map((input) => ({ input, output: schemas.hostOf(input) }));

const hostsMatch = [
  ['example.com', 'example.com'],
  ['accounts.example.com', 'example.com'],
  ['example.com', 'accounts.example.com'],
  ['co.uk', 'example.co.uk'],
  ['localhost', 'app.localhost'],
  ['notexample.com', 'example.com'],
  ['a.b.c', 'b.c'],
].map(([item, page]) => ({ item, page, output: schemas.hostsMatch(item, page) }));

const passwords = [
  '',
  'password',
  'PASSWORD',
  'Tr0ub4dor&3-horse-staple!',
  'x9$Kq2!vLm8@Zr4#Tn6&',
  'aaaaaaaaaaaaaaaaaaaa',
  'abcdefghijklmnopqrst',
  'zyxwvutsrqponmlkjihg',
  '1234567890123',
  'correct horse battery staple',
  'pässwörd😀😀',
  'Welkom123',
  'a1!',
  'qwertyuiopasdfghjklzxcvbnm',
].map((input) => ({ input, bits: schemas.passwordEntropyBits(input), strength: schemas.passwordStrength(input) }));

const dotenvInputs = [
  'FIRST=one\nSECOND=two\n',
  'export API_KEY=abc123\r\nexport   SPACED = value with spaces  \r\n',
  '# comment\n\n   \nNO_EQUALS\n=empty-key\n1BAD=x\nhas-dash=x\nGOOD=yes',
  'QUOTED="line\\none\\ttab \\"q\\" back\\\\slash \\r"\nSINGLE=\'raw \\n value\'\nMIXED="unterminated\nINLINE=pass#word # comment\nTABBED=value\t# note\nEMPTY=\nEMPTY_QUOTES=""\nHASH_ONLY=#notacomment',
  'DUP=first\nOTHER=x\nDUP=second',
  '__proto__=x\nconstructor=y\ntoString=z',
  `${'K'.repeat(256)}=too-long\n${'very-long-invalid-key-name-that-goes-on-'.repeat(2)}=x`,
  'UNICODE=pässwörd 😀\nKEY_ÄÖ=x',
  'export =x\nexport\nexportX=1',
  "SQ='a'\nDQ=\"b\"\nLONE='\nLONE2=\"",
];
const dotenvCases = dotenvInputs.map((input) => {
  const output = dotenv.parseDotenv(input);
  return { input, output, keys: Object.keys(output.values) };
});
const renderCases = [
  { B: 'plain', A: 'with space', C: '' },
  { URL: 'https://example.com/path?x=1', PATH: './a/b:c@d-e_f.g' },
  { Q: 'say "hi"', BS: 'back\\slash', NL: 'line\nbreak', CR: 'a\rb', TAB: 'a\tb', UNI: 'pässwörd' },
  { Z: 'z', a: 'a', _: 'u', A1: 'x' },
].map((input) => ({ input, output: dotenv.renderDotenv(input) }));
const validKeys = ['A', '_', 'a1', '1A', 'A-B', 'K'.repeat(255), 'K'.repeat(256), 'Ä', ''].map((input) => ({
  input,
  output: dotenv.isValidSecretKey(input),
}));

const csvInputs: Array<[string, string]> = [
  [
    'auto',
    [
      'name,url,username,password,note',
      'GitHub,https://github.com/login,carol,gh-imported-password,',
      '"Multi, line",https://example.org,carol,"quoted ""pw""","line one\nline two"',
    ].join('\n'),
  ],
  ['auto', '\uFEFFurl,username,password,extra,name,grouping\r\nhttp://sn,,,secret note body,My note,Secure\r\nhttps://a.test,ann,pw1,,A,\r\n\r\n,,,,,\r\n'],
  ['auto', 'name,type,login_uri,login_username,login_password,login_totp,notes\nBW,login,https://bw.test,bob,pw,JBSWY3DPEHPK3PXP,\nNote,note,,,,,"secure\nnote"\nCard,card,,,,,\nBad2fa,login,https://x.test,x,y,not base32 !!!,'],
  ['auto', 'name,url,username,password,note,cardholdername,cardnumber,cvc,expirydate,type,additional_urls\nVisa,,,,,Carol,4111111111114242,123,08/29,credit_card,\nId,,,,,,,,,identity,\nN,,,,body,,,,,note,\nL,https://n.test,u,p,,,,,,password,'],
  ['auto', 'title,website,username,password,otpauth,notes\n1P,https://1p.test,u,p,otpauth://totp/x?secret=JBSWY3DPEHPK3PXP,\n,,,,,'],
  ['generic', 'account,login url,user,password,comments,card number\nCardish,,,,,4242\nLogin,,,,,\nOnly URL,https://only.test,,,,'],
  ['auto', `name,url,username,password\n${'T'.repeat(201)},https://t.test,u,p\nLongUser,https://t.test,${'u'.repeat(256)},p`],
  ['auto', ''],
  ['auto', '\n\n'],
  ['auto', 'name,url,username\nX,https://x.test,u'],
  ['lastpass', 'url,username,password,extra,name,grouping\nhttp://sn,,,note,N,'],
  ['chrome', 'a,b\n"open quote,never closed\nmore'],
];
const importCases = csvInputs.map(([format, content]) => {
  try {
    return { format, content, output: importer.parseImport(content, format as never) };
  } catch (err) {
    return { format, content, error: (err as Error).message };
  }
});
const csvCases = ['a,b,c\n1,"2,3",4', 'x\r\ny\rz', '"a""b",c', 'a,b,\n,,\n', '"line\nbreak",x\ny'].map((input) => ({
  input,
  output: importer.parseCsv(input),
}));

// Zod's answers for the request bodies. The route-local schemas are copied
// from routes/weldpass/index.ts (they are not exported); the others are the
// real ones.
const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(60).optional(),
  description: z.string().max(2000).nullish(),
});
const createCredentialSchema = z.object({
  provider: z.enum(['cloudflare_workers', 'cloudflare_pages', 'vercel']),
  name: z.string().min(1).max(100),
  token: z.string().min(1).max(4096),
  metadata: z.object({ accountId: z.string().max(100).optional(), teamId: z.string().max(100).optional() }).optional(),
});
const createTargetSchema = z.object({
  environmentId: z.string().min(1).max(30),
  credentialId: z.string().min(1).max(30),
  name: z.string().min(1).max(100),
  config: syncConfig.syncTargetConfigSchema,
  autoSync: z.boolean().optional(),
  prune: z.boolean().optional(),
});
const zodCases: Array<{ schema: string; body: unknown; result: unknown }> = [];
const zod = (name: string, schema: { safeParse: (body: unknown) => unknown }, bodies: unknown[]) => {
  for (const body of bodies) zodCases.push({ schema: name, body, result: JSON.parse(JSON.stringify(schema.safeParse(body))) });
};
zod('createProject', createProjectSchema, [{}, { name: '' }, { name: 'x', slug: '', description: 5 }, { name: 'ok', description: null }]);
zod('createCredential', createCredentialSchema, [
  { provider: 'aws', name: 'x', token: 't' },
  { provider: 'vercel', name: 'x', token: 't', metadata: { accountId: 1 } },
]);
zod('createTarget', createTargetSchema, [
  { environmentId: 'e', credentialId: 'c', name: 'n', config: { provider: 'netlify' } },
  { environmentId: 'e', credentialId: 'c', name: 'n', config: {} },
  { environmentId: 'e', credentialId: 'c', name: 'n', config: 'x' },
  { environmentId: 'e', credentialId: 'c', name: 'n', config: { provider: 'cloudflare_pages', accountId: '', projectName: 'p', environment: 'staging' } },
  { environmentId: 'e', credentialId: 'c', name: 'n', config: { provider: 'vercel', projectId: 'p', targets: [] } },
  { environmentId: 'e', credentialId: 'c', name: 'n', config: { provider: 'vercel', projectId: 'p', targets: ['production', 'qa', 'preview', 'development'] } },
  { environmentId: 'e', credentialId: 'c', name: 'n', config: { provider: 'vercel', projectId: 'p', teamId: 'team', targets: ['preview'], extra: 1 } },
  { config: { provider: 'cloudflare_workers', accountId: 'a', scriptName: 's' } },
]);
zod('item', schemas.itemInputSchema, [
  { type: 'login', title: '  GitHub  ', url: '  https://github.com  ', fields: { username: 'u', password: 'p' } },
  { type: 'login', title: 'x', fields: {} },
  { type: 'login', title: '   ', fields: { username: 5, totp: null } },
  { type: 'note', title: 'n', fields: { content: 'c' }, url: 'ignored' },
  { type: 'card', title: 'c', fields: { number: '  4242  ', expiry: '12345678901', notes: 3 } },
  { type: 'wallet', title: 'w', fields: {} },
  { title: 'missing type' },
  [],
  { type: 'login', title: 'x', url: null, fields: { username: 'u', password: 'p', totp: ' JBSW ', notes: 'n' } },
  { type: 'login', title: 'x', fields: null },
]);
zod('createVault', schemas.createVaultSchema, [{ name: '  ' }, { name: ' Team ', description: '  ' }, { name: 'x'.repeat(101) }]);
zod('addVaultMember', schemas.addVaultMemberSchema, [{ userId: '', role: 'owner' }, { userId: 'u', role: 'viewer' }]);
zod('importItems', schemas.importItemsSchema, [{ content: 'x' }, { content: 'x', format: 'keepass' }, {}]);
zod('restoreItem', schemas.restoreItemSchema, [{ version: 0 }, { version: 1.5 }, { version: '1' }, { version: 2 }]);

write('cases-ts.json', {
  $comment: 'Outputs of pass-api helpers and Zod schemas (tools/fixtures.mts); checked by rust/modules/pass/src/cases.rs.',
  slugify,
  hostOf,
  hostsMatch,
  passwords,
  dotenv: dotenvCases,
  renderDotenv: renderCases,
  validKeys,
  csv: csvCases,
  imports: importCases,
  zod: zodCases,
});

console.log(`fixtures written to ${path.relative(repo, out)}`);
