Bundling shims for API workers. `@weldsuite/db`'s lib barrel optionally
imports Next.js / Clerk-for-Next / React helpers that crash the Workers
runtime; each API worker's `wrangler.toml` `[alias]` points those imports
here. Nothing imports these files directly.
