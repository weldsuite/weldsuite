/**
 * Logo Fetch Utility
 *
 * Fetches company logos from Hunter.io and stores them in R2.
 * Falls back to a generated initials avatar when no logo is found.
 */

/**
 * Extract a bare domain from a URL or domain string.
 * Strips protocol, www prefix, path, query, and fragment.
 */
export function extractDomain(input: string): string | null {
  let domain = input.trim().toLowerCase();
  if (!domain) return null;

  // Add protocol if missing so URL parsing works
  if (!domain.startsWith('http://') && !domain.startsWith('https://')) {
    domain = `https://${domain}`;
  }

  try {
    const url = new URL(domain);
    let hostname = url.hostname;
    // Strip www. prefix
    if (hostname.startsWith('www.')) {
      hostname = hostname.slice(4);
    }
    return hostname || null;
  } catch {
    return null;
  }
}

/**
 * Deterministic color from a string — same input always gives the same color.
 */
function getColorForName(name: string): string {
  const colors = [
    '#4F46E5', '#7C3AED', '#EC4899', '#EF4444', '#F97316',
    '#EAB308', '#22C55E', '#14B8A6', '#06B6D4', '#3B82F6',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

/**
 * Generate a simple SVG avatar with initials.
 */
function generateInitialsAvatar(name: string): string {
  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .substring(0, 2)
    .toUpperCase() || '?';
  const bg = getColorForName(name);

  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">',
    `<rect width="128" height="128" rx="16" fill="${bg}"/>`,
    '<text x="64" y="64" text-anchor="middle" dominant-baseline="central"',
    ' font-family="system-ui,sans-serif" font-weight="600"',
    ` font-size="${initials.length > 1 ? '48' : '56'}" fill="#fff">`,
    initials,
    '</text>',
    '</svg>',
  ].join('');
}

interface FetchAndStoreLogoParams {
  website?: string;
  /**
   * Contact email — when provided, Gravatar is tried before falling through
   * to the initials avatar. Only takes effect when no logo was resolvable
   * from `website`. Gravatar lookups use SHA-256 of the trimmed lowercased
   * email and the `d=404` parameter so unknown emails fall through cleanly
   * instead of returning the default robot.
   */
  email?: string;
  customerName: string;
  customerId: string;
  workspaceId: string;
  storage: R2Bucket;
  r2PublicUrl: string;
  /** Override the entity folder (default: 'customers'). Use 'contacts' for contact avatars. */
  entityFolder?: string;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Try to fetch a Gravatar for the given email. Returns the image bytes +
 * detected content-type on hit, or null on 404 / network error.
 */
async function fetchGravatar(
  email: string,
): Promise<{ body: ArrayBuffer; contentType: string } | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  let hash: string;
  try {
    hash = await sha256Hex(normalized);
  } catch {
    return null;
  }
  const url = `https://gravatar.com/avatar/${hash}?d=404&s=256`;
  try {
    const response = await fetch(url, { headers: { Accept: 'image/*' } });
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') || 'image/png';
    if (!contentType.startsWith('image/')) return null;
    const body = await response.arrayBuffer();
    if (body.byteLength === 0) return null;
    return { body, contentType };
  } catch {
    return null;
  }
}

/**
 * Fetch a company logo from Hunter.io and store it in R2.
 * If no logo is found (or no website provided), generates an initials avatar instead.
 * Always returns a public URL.
 */
export async function fetchAndStoreLogo({
  website,
  email,
  customerName,
  customerId,
  workspaceId,
  storage,
  r2PublicUrl,
  entityFolder = 'customers',
}: FetchAndStoreLogoParams): Promise<string> {
  const basePath = `workspaces/${workspaceId}/avatars/${entityFolder}/${customerId}`;

  // Try Gravatar first when an email is provided. Cheaper and more
  // appropriate than Hunter for individual people; falls through cleanly
  // on miss thanks to `d=404`.
  if (email) {
    const gravatar = await fetchGravatar(email);
    if (gravatar) {
      const ext = gravatar.contentType.includes('svg') ? 'svg' : 'png';
      const r2Key = `${basePath}/logo.${ext}`;
      await storage.put(r2Key, gravatar.body, {
        httpMetadata: { contentType: gravatar.contentType },
      });
      const publicUrl = `${r2PublicUrl}/${r2Key}`;
      console.log('[LogoFetch] Stored gravatar for', email, 'at', publicUrl);
      return publicUrl;
    }
  }

  // Try Hunter.io if a website/domain is provided
  if (website) {
    const domain = extractDomain(website);
    if (domain) {
      const logoUrl = `https://logos.hunter.io/${domain}`;
      console.log('[LogoFetch] Fetching logo for', domain);

      try {
        const response = await fetch(logoUrl, {
          headers: { Accept: 'image/*' },
        });

        if (response.ok) {
          const contentType = response.headers.get('content-type') || '';
          if (contentType.startsWith('image/')) {
            const body = await response.arrayBuffer();
            if (body.byteLength > 0) {
              const ext = contentType.includes('svg') ? 'svg' : 'png';
              const r2Key = `${basePath}/logo.${ext}`;

              await storage.put(r2Key, body, {
                httpMetadata: { contentType },
              });

              const publicUrl = `${r2PublicUrl}/${r2Key}`;
              console.log('[LogoFetch] Stored logo for', domain, 'at', publicUrl);
              return publicUrl;
            }
          }
        }

        console.log('[LogoFetch] No logo found for', domain, '- falling back to initials');
      } catch (err) {
        console.log('[LogoFetch] Failed to fetch logo for', domain, '- falling back to initials:', err);
      }
    }
  }

  // Fallback: generate an initials avatar
  const svg = generateInitialsAvatar(customerName);
  const r2Key = `${basePath}/logo.svg`;

  await storage.put(r2Key, svg, {
    httpMetadata: { contentType: 'image/svg+xml' },
  });

  const publicUrl = `${r2PublicUrl}/${r2Key}`;
  console.log('[LogoFetch] Stored initials avatar for', customerName, 'at', publicUrl);
  return publicUrl;
}
