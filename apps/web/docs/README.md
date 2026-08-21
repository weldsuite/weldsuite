# WeldSuite Help (`docs`)

Public product help site for WeldSuite setup guides. Intended production host: **https://help.weldsuite.com**.

Built with Next.js + MDX (same Protocol template stack as `api-docs`).

## Local development

From the monorepo root:

```bash
pnpm --filter docs dev
```

App runs on [http://localhost:3010](http://localhost:3010).

```bash
pnpm --filter docs build
pnpm --filter docs start
```

## Content

- Home: `src/app/page.mdx`
- WeldHost overview: `src/app/weldhost/page.mdx`
- Manage DNS records: `src/app/weldhost/manage-dns-records/page.mdx`
- Sidebar nav: `src/components/Navigation.tsx`

Add a guide by creating a route folder with `page.mdx` + `layout.tsx` (metadata), then linking it in `Navigation.tsx`.

## Deploy (`help.weldsuite.com`)

1. Create a Vercel project with root directory `apps/web/docs` (or monorepo filter for package `docs`).
2. Use the included `vercel.json` install/build settings.
3. Attach the custom domain **help.weldsuite.com**.
4. App catalog links already point at `https://help.weldsuite.com/{app}` (see `apps/web/admin/lib/apps-seed-data.ts`).

This app is not deployed by the Cloudflare Pages workflow used for the main platform.
