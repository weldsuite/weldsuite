// A route handler rather than robots.ts, for the same reason as sitemap.xml:
// Next.js doesn't pass `params` to metadata routes.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ domain: string }> },
) {
  const { domain } = await params;
  const body = ['User-Agent: *', 'Allow: /', '', `Sitemap: https://${domain}/sitemap.xml`, ''].join(
    '\n',
  );
  return new Response(body, { headers: { 'Content-Type': 'text/plain' } });
}
