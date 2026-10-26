import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The directory of a manifest key's Worker: `apps/workers/<name>`, or a web
 * app that deploys as a Worker (`apps/web/<name>` with a wrangler.toml, such
 * as sign-portal). Null when neither exists.
 */
export function workerPath(name: string): string | null {
  const worker = join(process.cwd(), "apps", "workers", name);
  if (existsSync(worker)) return worker;
  const web = join(process.cwd(), "apps", "web", name);
  return existsSync(join(web, "wrangler.toml")) ? web : null;
}
