import { mkdir, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src/ui/styles.css');
const destDir = join(root, 'dist/ui');
const dest = join(destDir, 'styles.css');

await mkdir(destDir, { recursive: true });
await copyFile(src, dest);
console.log('copied ui/styles.css → dist/ui/styles.css');
