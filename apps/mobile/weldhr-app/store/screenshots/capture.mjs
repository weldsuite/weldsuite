/**
 * Capture WeldHR store screenshots from scenes.html.
 *
 *   node apps/mobile/weldhr-app/store/screenshots/capture.mjs
 *
 * Needs Playwright Chromium. If it is not installed:
 *   npx --yes playwright install chromium
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(ROOT, 'scenes.html');
const require = createRequire(import.meta.url);

function loadPlaywright() {
  const candidates = [
    path.resolve(ROOT, '../../../../web/platform/node_modules/playwright'),
    path.resolve(ROOT, '../../../../web/docs/node_modules/playwright'),
    path.resolve(ROOT, '../../../../../node_modules/playwright'),
    path.resolve(ROOT, 'node_modules/playwright'),
    'playwright',
  ];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      /* try next */
    }
  }
  throw new Error('Playwright not found. Run: npx --yes playwright install chromium');
}

// Same order as screenshots/README.md.
const SCENES = [
  ['01-home', 'home'],
  ['02-schedule', 'schedule'],
  ['03-absence', 'absence'],
  ['04-request-leave', 'leave'],
  ['05-expenses', 'expenses'],
  ['06-team', 'team'],
  ['07-pay', 'pay'],
  ['08-profile', 'profile'],
];

const SIZES = {
  // What App Store Connect asks for first ("iPhone with Dynamic Island, medium display").
  'ios-6.3': {
    width: 402,
    height: 874,
    deviceScaleFactor: 3, // 1206×2622
    platform: 'ios',
  },
  'ios-6.9': {
    width: 440,
    height: 956,
    deviceScaleFactor: 3, // 1320×2868
    platform: 'ios',
  },
  'ios-6.5': {
    width: 414,
    height: 896,
    deviceScaleFactor: 3, // 1242×2688
    platform: 'ios',
  },
  'android-phone': {
    width: 430,
    height: 932,
    deviceScaleFactor: 1080 / 430, // 1080×2341
    platform: 'android',
  },
  'ios-ipad-13': {
    width: 1032,
    height: 1376,
    deviceScaleFactor: 2, // 2064×2752
    platform: 'ios',
  },
};

async function main() {
  if (!existsSync(HTML)) throw new Error(`Missing ${HTML}`);
  const { chromium } = loadPlaywright();
  // Prefer bundled Chromium; fall back to system Chrome when browsers aren't installed.
  let browser;
  try {
    browser = await chromium.launch();
  } catch {
    browser = await chromium.launch({ channel: 'chrome' });
  }
  const fileUrl = pathToFileURL(HTML).href;

  for (const [folder, size] of Object.entries(SIZES)) {
    const outDir = path.join(ROOT, folder);
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });

    const page = await browser.newPage({
      viewport: { width: size.width, height: size.height },
      deviceScaleFactor: size.deviceScaleFactor,
      isMobile: true,
      hasTouch: true,
    });

    for (const [name, scene] of SCENES) {
      await page.goto(`${fileUrl}?scene=${scene}&platform=${size.platform}`, { waitUntil: 'networkidle' });
      await page.screenshot({ path: path.join(outDir, `${name}.png`), type: 'png' });
      console.log(`${folder}/${name}.png`);
    }
    await page.close();
  }

  await browser.close();
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
