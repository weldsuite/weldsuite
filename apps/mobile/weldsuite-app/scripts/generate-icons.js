const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const SOURCE_LOGO = path.join(__dirname, '../../platform/public/assets/images/weldsuite/logo-light.png');
const OUTPUT_DIR = path.join(__dirname, '../assets/images');

const BACKGROUND_COLOR = { r: 255, g: 255, b: 255, alpha: 1 }; // White background

async function generateIcons() {
  console.log('Generating icons from:', SOURCE_LOGO);
  console.log('Output directory:', OUTPUT_DIR);

  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Load source image
  const sourceImage = sharp(SOURCE_LOGO);
  const metadata = await sourceImage.metadata();
  console.log(`Source image: ${metadata.width}x${metadata.height}`);

  // 1. icon.png - 1024x1024 with white background
  console.log('Creating icon.png (1024x1024)...');
  await sharp(SOURCE_LOGO)
    .resize(800, 800, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .extend({
      top: 112,
      bottom: 112,
      left: 112,
      right: 112,
      background: BACKGROUND_COLOR
    })
    .flatten({ background: BACKGROUND_COLOR })
    .png()
    .toFile(path.join(OUTPUT_DIR, 'icon.png'));

  // 2. android-icon-foreground.png - 512x512 with transparency (logo in safe zone ~340px)
  console.log('Creating android-icon-foreground.png (512x512)...');
  await sharp(SOURCE_LOGO)
    .resize(320, 320, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .extend({
      top: 96,
      bottom: 96,
      left: 96,
      right: 96,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png()
    .toFile(path.join(OUTPUT_DIR, 'android-icon-foreground.png'));

  // 3. android-icon-background.png - 512x512 solid white
  console.log('Creating android-icon-background.png (512x512)...');
  await sharp({
    create: {
      width: 512,
      height: 512,
      channels: 4,
      background: BACKGROUND_COLOR
    }
  })
    .png()
    .toFile(path.join(OUTPUT_DIR, 'android-icon-background.png'));

  // 4. android-icon-monochrome.png - 432x432 (black silhouette on transparent)
  console.log('Creating android-icon-monochrome.png (432x432)...');
  await sharp(SOURCE_LOGO)
    .resize(280, 280, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .extend({
      top: 76,
      bottom: 76,
      left: 76,
      right: 76,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png()
    .toFile(path.join(OUTPUT_DIR, 'android-icon-monochrome.png'));

  // 5. splash-icon.png - 1024x1024 with transparency
  console.log('Creating splash-icon.png (1024x1024)...');
  await sharp(SOURCE_LOGO)
    .resize(600, 600, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .extend({
      top: 212,
      bottom: 212,
      left: 212,
      right: 212,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png()
    .toFile(path.join(OUTPUT_DIR, 'splash-icon.png'));

  // 6. notification-icon.png - 432x432 (white silhouette)
  // For notification icons, we need a white version. We'll invert the black logo.
  console.log('Creating notification-icon.png (432x432)...');
  await sharp(SOURCE_LOGO)
    .resize(280, 280, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .negate({ alpha: false }) // Invert colors (black becomes white)
    .extend({
      top: 76,
      bottom: 76,
      left: 76,
      right: 76,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png()
    .toFile(path.join(OUTPUT_DIR, 'notification-icon.png'));

  // 7. favicon.png - 48x48
  console.log('Creating favicon.png (48x48)...');
  await sharp(SOURCE_LOGO)
    .resize(40, 40, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .extend({
      top: 4,
      bottom: 4,
      left: 4,
      right: 4,
      background: BACKGROUND_COLOR
    })
    .flatten({ background: BACKGROUND_COLOR })
    .png()
    .toFile(path.join(OUTPUT_DIR, 'favicon.png'));

  console.log('\nAll icons generated successfully!');
  console.log('Files created:');
  console.log('  - icon.png (1024x1024)');
  console.log('  - android-icon-foreground.png (512x512)');
  console.log('  - android-icon-background.png (512x512)');
  console.log('  - android-icon-monochrome.png (432x432)');
  console.log('  - splash-icon.png (1024x1024)');
  console.log('  - notification-icon.png (432x432)');
  console.log('  - favicon.png (48x48)');
}

generateIcons().catch(console.error);
