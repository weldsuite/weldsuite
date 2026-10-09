/** Services the embed block knows how to turn a share link into a player URL for. */
export const EMBED_PROVIDERS = [
  'generic',
  'youtube',
  'vimeo',
  'loom',
  'figma',
  'googleDrive',
  'googleMaps',
  'codepen',
  'miro',
] as const;

export type EmbedProvider = (typeof EMBED_PROVIDERS)[number];

export interface ResolvedEmbed {
  /** What the iframe loads. Always https. */
  src: string;
  provider: EmbedProvider;
  /** Video players keep 16:9; everything else gets a fixed document height. */
  layout: 'video' | 'document';
}

/**
 * Parse what the user pasted into an https URL. A bare `youtube.com/…` gets
 * the scheme added; anything that is not https (http, javascript:, data:, …)
 * is rejected, because the result ends up in an iframe `src` or a link.
 */
export function parseHttpsUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !url.hostname.includes('.')) return null;
  return url;
}

function host(url: URL): string {
  return url.hostname.toLowerCase().replace(/^www\./, '');
}

function youtubeId(url: URL): string | null {
  const h = host(url);
  const parts = url.pathname.split('/').filter(Boolean);
  let id: string | undefined;
  if (h === 'youtu.be') {
    id = parts[0];
  } else if (h === 'youtube.com' || h === 'm.youtube.com' || h === 'youtube-nocookie.com') {
    if (parts[0] === 'watch') id = url.searchParams.get('v') ?? undefined;
    else if (['embed', 'shorts', 'live', 'v'].includes(parts[0] ?? '')) id = parts[1];
  }
  return id && /^[\w-]{6,}$/.test(id) ? id : null;
}

/** `t=90`, `t=1m30s` or `start=90` → whole seconds. */
function youtubeStart(url: URL): number | null {
  const raw = url.searchParams.get('t') ?? url.searchParams.get('start');
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(raw);
  if (!match || !match[0]) return null;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

function googleMapsSrc(url: URL): string | null {
  if (url.pathname.startsWith('/maps/embed')) return url.toString();
  let query = url.searchParams.get('q') ?? url.searchParams.get('query');
  if (!query) {
    const place = /\/maps\/(?:place|search)\/([^/@]+)/.exec(url.pathname);
    if (place) query = decodeURIComponent(place[1]!.replace(/\+/g, ' '));
  }
  if (!query) {
    const coords = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(url.pathname);
    if (coords) query = `${coords[1]},${coords[2]}`;
  }
  return query ? `https://www.google.com/maps?q=${encodeURIComponent(query)}&output=embed` : null;
}

/**
 * Turn a pasted link into something an iframe can show. Known services are
 * rewritten to their embeddable player URL (a normal YouTube watch page
 * refuses to be framed); any other https link is embedded as-is. Returns null
 * for input that is not an https link, or a known service's link that has no
 * embeddable form.
 */
export function resolveEmbed(raw: string): ResolvedEmbed | null {
  const url = parseHttpsUrl(raw);
  if (!url) return null;
  const h = host(url);
  const parts = url.pathname.split('/').filter(Boolean);

  if (h === 'youtu.be' || h.endsWith('youtube.com') || h === 'youtube-nocookie.com') {
    const id = youtubeId(url);
    if (!id) return null;
    const start = youtubeStart(url);
    return {
      src: `https://www.youtube-nocookie.com/embed/${id}${start ? `?start=${start}` : ''}`,
      provider: 'youtube',
      layout: 'video',
    };
  }

  if (h === 'vimeo.com' || h === 'player.vimeo.com') {
    const id = parts.find((part) => /^\d+$/.test(part));
    return id ? { src: `https://player.vimeo.com/video/${id}`, provider: 'vimeo', layout: 'video' } : null;
  }

  if (h === 'loom.com') {
    const id = ['share', 'embed'].includes(parts[0] ?? '') ? parts[1] : undefined;
    return id ? { src: `https://www.loom.com/embed/${id}`, provider: 'loom', layout: 'video' } : null;
  }

  if (h === 'figma.com') {
    if (parts[0] === 'embed') return { src: url.toString(), provider: 'figma', layout: 'document' };
    return {
      src: `https://www.figma.com/embed?embed_host=weldsuite&url=${encodeURIComponent(url.toString())}`,
      provider: 'figma',
      layout: 'document',
    };
  }

  if (h === 'drive.google.com' || h === 'docs.google.com') {
    // …/file/d/<id>/view, …/document/d/<id>/edit, …/spreadsheets/d/<id>/…
    const d = parts.indexOf('d');
    const id = d > 0 ? parts[d + 1] : undefined;
    if (!id) return null;
    return {
      src: `https://${h}/${parts.slice(0, d).join('/')}/d/${id}/preview`,
      provider: 'googleDrive',
      layout: 'document',
    };
  }

  if ((h === 'google.com' || h.startsWith('google.')) && parts[0] === 'maps') {
    const src = googleMapsSrc(url);
    return src ? { src, provider: 'googleMaps', layout: 'document' } : null;
  }

  if (h === 'codepen.io') {
    const kind = parts.findIndex((part) => ['pen', 'embed', 'full', 'details'].includes(part));
    const user = parts[0];
    const id = kind > 0 ? parts[kind + 1] : undefined;
    return user && id
      ? { src: `https://codepen.io/${user}/embed/${id}?default-tab=result`, provider: 'codepen', layout: 'document' }
      : null;
  }

  if (h === 'miro.com') {
    if (parts.includes('live-embed')) return { src: url.toString(), provider: 'miro', layout: 'document' };
    const board = parts.indexOf('board');
    const id = board >= 0 ? parts[board + 1] : undefined;
    return id
      ? { src: `https://miro.com/app/live-embed/${id}/`, provider: 'miro', layout: 'document' }
      : null;
  }

  return { src: url.toString(), provider: 'generic', layout: 'document' };
}
