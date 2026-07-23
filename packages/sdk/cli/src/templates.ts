import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Root of the bundled templates directory. Works from both `src/` (tsx/dev)
 * and the compiled `dist/` because both sit one level below the package
 * root, next to `templates/`.
 */
export function templatesRoot(): string {
  return fileURLToPath(new URL('../templates/', import.meta.url));
}

/**
 * Names that cannot be stored as-is in the published package (npm drops
 * `.gitignore` files from tarballs) — renamed on copy.
 */
const RENAMES: Record<string, string> = {
  _gitignore: '.gitignore',
  _claude: '.claude',
};

/** Replace `{{KEY}}` placeholders; unknown placeholders are left untouched. */
export function substitute(content: string, vars: Record<string, string>): string {
  return content.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key: string) => vars[key] ?? match);
}

/**
 * Recursively copy a template directory to `dest`, applying placeholder
 * substitution to every file. Returns the dest-relative paths written.
 */
export async function copyTemplateDir(
  src: string,
  dest: string,
  vars: Record<string, string>,
  relativeBase = '',
): Promise<string[]> {
  const written: string[] = [];
  await mkdir(dest, { recursive: true });

  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const targetName = RENAMES[entry.name] ?? entry.name;
    const srcPath = join(src, entry.name);
    const destPath = join(dest, targetName);
    const relativePath = relativeBase ? `${relativeBase}/${targetName}` : targetName;

    if (entry.isDirectory()) {
      written.push(...(await copyTemplateDir(srcPath, destPath, vars, relativePath)));
    } else if (entry.isFile()) {
      const content = await readFile(srcPath, 'utf8');
      await writeFile(destPath, substitute(content, vars), 'utf8');
      written.push(relativePath);
    }
  }
  return written;
}
