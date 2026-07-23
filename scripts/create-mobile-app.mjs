#!/usr/bin/env node
/**
 * Scaffold a new mobile app from apps/mobile/_template.
 *
 * Usage:
 *   pnpm create:mobile-app --name "WeldFoo" --code weldfoo [--subtitle "..."] [--color "#3B82F6"]
 *
 * Flags:
 *   --name       Display name (required)           e.g. "WeldFoo"
 *   --code       One-word lowercase id (required)  e.g. "weldfoo"
 *   --slug       Folder + package name             default: "<code>-app"
 *   --bundle     iOS/Android bundle id             default: "com.weldsuite.<code>"
 *   --subtitle   Login-screen subtitle             default: ""
 *   --color      Primary hex color                 default: "#3B82F6"
 *   --eas-id     EAS project UUID                  default: placeholder zeros
 *   --eas-init   Run `eas init` in the new app folder after scaffolding.
 *                Requires eas-cli installed globally and you to be logged in
 *                to the `weldsuite` Expo org. Rewrites app.json + .env with
 *                the real project id on success.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const templateDir = path.join(repoRoot, 'apps', 'mobile', '_template');

// Files we should not string-replace inside (binary).
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.ttf', '.otf', '.woff', '.woff2']);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = 'true';
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function die(msg) {
  console.error(`\x1b[31m✘ ${msg}\x1b[0m`);
  process.exit(1);
}

function normalizeCode(code) {
  const trimmed = code.trim().toLowerCase();
  if (!/^[a-z][a-z0-9]*$/.test(trimmed)) {
    die(`--code must be lowercase letters/digits only, starting with a letter. Got: "${code}"`);
  }
  return trimmed;
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyDir(src, dst, replacements) {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    // Skip generated / junk folders inside the template.
    if (entry.name === 'node_modules' || entry.name === '.expo' || entry.name === 'dist') continue;

    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);

    if (entry.isDirectory()) {
      await copyDir(srcPath, dstPath, replacements);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (BINARY_EXT.has(ext)) {
        await fs.copyFile(srcPath, dstPath);
      } else {
        let contents = await fs.readFile(srcPath, 'utf8');
        for (const [token, value] of Object.entries(replacements)) {
          contents = contents.split(token).join(value);
        }
        await fs.writeFile(dstPath, contents);
      }
    }
  }
}

async function listSiblingMobileApps(excludeSlug) {
  const mobileDir = path.join(repoRoot, 'apps', 'mobile');
  const entries = await fs.readdir(mobileDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => n !== '_template' && n !== excludeSlug);
}

async function appendEasignoreEntries(slug, siblings) {
  // Append the new app's slug to each sibling's .easignore so their builds skip it.
  for (const sibling of siblings) {
    const easignorePath = path.join(repoRoot, 'apps', 'mobile', sibling, '.easignore');
    if (!(await pathExists(easignorePath))) continue;
    const existing = await fs.readFile(easignorePath, 'utf8');
    const line = `apps/mobile/${slug}`;
    if (existing.split(/\r?\n/).includes(line)) continue;
    const updated = existing.endsWith('\n') ? existing + line + '\n' : existing + '\n' + line + '\n';
    await fs.writeFile(easignorePath, updated);
  }

  // Also extend the new app's own .easignore with lines for each sibling.
  const newEasignore = path.join(repoRoot, 'apps', 'mobile', slug, '.easignore');
  if (await pathExists(newEasignore)) {
    const existing = await fs.readFile(newEasignore, 'utf8');
    const lines = siblings.map((s) => `apps/mobile/${s}`);
    const updated = existing + lines.join('\n') + '\n';
    await fs.writeFile(newEasignore, updated);
  }
}

function hasEasCli() {
  const probe = spawnSync(process.platform === 'win32' ? 'eas.cmd' : 'eas', ['--version'], {
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  return probe.status === 0;
}

async function runEasInit(destDir, placeholderUuid) {
  if (!hasEasCli()) {
    console.error('\x1b[31m✘ eas-cli not found on PATH.\x1b[0m');
    console.error('  Install it with: npm install -g eas-cli');
    console.error('  Then run: cd apps/mobile/<slug> && eas init --force');
    return false;
  }

  console.log('\x1b[36m→ Running `eas init --force` (you may be prompted to log in)...\x1b[0m');
  const result = spawnSync(process.platform === 'win32' ? 'eas.cmd' : 'eas', ['init', '--force'], {
    cwd: destDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.status !== 0) {
    console.error('\x1b[31m✘ `eas init` failed. Fix the issue above and re-run it manually inside the app folder.\x1b[0m');
    return false;
  }

  // Read the projectId `eas init` wrote back into app.json.
  const appJsonPath = path.join(destDir, 'app.json');
  const appJson = JSON.parse(await fs.readFile(appJsonPath, 'utf8'));
  const projectId = appJson?.expo?.extra?.eas?.projectId;

  if (!projectId || projectId === placeholderUuid) {
    console.error('\x1b[31m✘ Could not read projectId from app.json after `eas init`. Inspect app.json manually.\x1b[0m');
    return false;
  }

  // Sync updates.url with the real projectId (eas init only writes extra.eas.projectId).
  if (appJson.expo.updates) {
    appJson.expo.updates.url = `https://u.expo.dev/${projectId}`;
  }
  await fs.writeFile(appJsonPath, JSON.stringify(appJson, null, 2) + '\n');

  // Sync .env's EXPO_PUBLIC_EAS_PROJECT_ID.
  const envPath = path.join(destDir, '.env');
  if (await pathExists(envPath)) {
    let envContents = await fs.readFile(envPath, 'utf8');
    if (/EXPO_PUBLIC_EAS_PROJECT_ID=/.test(envContents)) {
      envContents = envContents.replace(/EXPO_PUBLIC_EAS_PROJECT_ID=.*/g, `EXPO_PUBLIC_EAS_PROJECT_ID=${projectId}`);
    } else {
      envContents = envContents.trimEnd() + `\nEXPO_PUBLIC_EAS_PROJECT_ID=${projectId}\n`;
    }
    await fs.writeFile(envPath, envContents);
  }

  console.log(`\x1b[32m✔ EAS project linked: ${projectId}\x1b[0m`);
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.name) die('--name is required (e.g. --name "WeldFoo")');
  if (!args.code) die('--code is required (e.g. --code weldfoo)');

  const name = args.name;
  const code = normalizeCode(args.code);
  const slug = (args.slug && args.slug !== 'true') ? args.slug : `${code}-app`;
  const bundle = (args.bundle && args.bundle !== 'true') ? args.bundle : `com.weldsuite.${code}`;
  const subtitle = (args.subtitle && args.subtitle !== 'true') ? args.subtitle : '';
  const color = (args.color && args.color !== 'true') ? args.color : '#3B82F6';
  const easId = (args['eas-id'] && args['eas-id'] !== 'true') ? args['eas-id'] : '00000000-0000-0000-0000-000000000000';

  const destDir = path.join(repoRoot, 'apps', 'mobile', slug);

  if (!(await pathExists(templateDir))) {
    die(`Template not found at ${templateDir}`);
  }
  if (await pathExists(destDir)) {
    die(`Destination already exists: ${destDir}`);
  }

  const replacements = {
    '{{APP_NAME}}': name,
    '{{APP_SLUG}}': slug,
    '{{APP_CODE}}': code,
    '{{APP_SUBTITLE}}': subtitle,
    '{{BUNDLE_ID}}': bundle,
    '{{PRIMARY_COLOR}}': color,
    '{{EAS_PROJECT_ID}}': easId,
  };

  console.log(`\x1b[36m→ Scaffolding ${slug} at apps/mobile/${slug}\x1b[0m`);
  console.log(`  name:      ${name}`);
  console.log(`  code:      ${code}`);
  console.log(`  bundle:    ${bundle}`);
  console.log(`  color:     ${color}`);
  console.log(`  easId:     ${easId}`);

  await copyDir(templateDir, destDir, replacements);

  // Wire up .easignore cross-references so each mobile app's EAS build skips the others.
  const siblings = await listSiblingMobileApps(slug);
  await appendEasignoreEntries(slug, siblings);

  // Rename .env.example so people remember to fill it in; leave a copy at .env.example too.
  const envExample = path.join(destDir, '.env.example');
  if (await pathExists(envExample)) {
    const envTarget = path.join(destDir, '.env');
    await fs.copyFile(envExample, envTarget);
  }

  // Optionally run `eas init` to link this app to a real EAS project.
  let easLinked = false;
  if (args['eas-init'] === 'true') {
    easLinked = await runEasInit(destDir, easId);
  }

  console.log(`\x1b[32m✔ Done.\x1b[0m`);
  console.log('');
  console.log('Next steps:');
  console.log(`  1. Fill in apps/mobile/${slug}/.env (Clerk publishable key).`);
  if (!easLinked) {
    console.log(`  2. Run \`eas init\` inside the app folder (or re-run this script with --eas-init).`);
    console.log(`     Paste the resulting id into app.json (expo.extra.eas.projectId + expo.updates.url)`);
    console.log(`     and into .env (EXPO_PUBLIC_EAS_PROJECT_ID).`);
  } else {
    console.log(`  2. EAS project already linked — app.json and .env have the real projectId.`);
  }
  console.log(`  3. Replace assets/images/*.png with branded art.`);
  console.log(`  4. From the repo root: pnpm install`);
  console.log(`  5. pnpm --filter ${slug} dev`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
