/**
 * Capture WeldChat store screenshots from scenes.html.
 *
 *   node apps/mobile/weldchat-app/store/screenshots/capture.mjs
 *
 * Needs Playwright Chromium. If it is not installed:
 *   npx --yes playwright install chromium
 */
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  throw new Error(
    'Playwright not found. Run: npx --yes playwright install chromium',
  );
}

const SCENES = [
  ['01-signin', 'login'],
  ['02-home', 'home'],
  ['03-dms', 'dms'],
  ['04-channel', 'channel'],
  ['05-incoming-call', 'call'],
  ['06-mentions', 'mentions'],
];

const SIZES = {
  'ios-6.7': {
    width: 428,
    height: 926,
    deviceScaleFactor: 3, // 1284×2778
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
  const browser = await chromium.launch();
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
      await page.goto(
        `${fileUrl}?scene=${scene}&platform=${size.platform}`,
        { waitUntil: 'networkidle' },
      );
      await page.screenshot({
        path: path.join(outDir, `${name}.png`),
        type: 'png',
      });
      console.log(`${folder}/${name}.png`);
    }
    await page.close();
  }

  const featureDir = path.join(ROOT, 'android-feature-graphic');
  await rm(featureDir, { recursive: true, force: true });
  await mkdir(featureDir, { recursive: true });
  const featurePage = await browser.newPage({
    viewport: { width: 1024, height: 500 },
    deviceScaleFactor: 1,
  });
  await featurePage.goto(`${fileUrl}?scene=feature`, { waitUntil: 'networkidle' });
  await featurePage.screenshot({
    path: path.join(featureDir, 'feature-graphic.png'),
    type: 'png',
  });
  console.log('android-feature-graphic/feature-graphic.png');
  await featurePage.close();

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
