/**
 * A YouTube or Vimeo address as its privacy-friendly embed: YouTube through
 * youtube-nocookie.com, Vimeo with `dnt=1`. Ported from site-components'
 * video embed, parsing with `URL` instead of regular expressions on the
 * whole string.
 */

export interface VideoEmbed {
  site: 'YouTube' | 'Vimeo';
  /** The player, autoplaying: it is only loaded after the visitor pressed play. */
  embedUrl: string;
  /** The video on its own site, for the link under the player. */
  watchUrl: string;
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_ID = /^\d{1,12}$/;
const VIMEO_HASH = /^[0-9a-f]{6,20}$/i;

function youtube(url: URL): VideoEmbed | null {
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = url.pathname.split('/')[1] ?? null;
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const [, first, second] = url.pathname.split('/');
    if (first === 'watch') id = url.searchParams.get('v');
    else if (first === 'embed' || first === 'shorts' || first === 'live' || first === 'v') id = second ?? null;
  }
  if (!id || !YOUTUBE_ID.test(id)) return null;
  return {
    site: 'YouTube',
    embedUrl: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`,
    watchUrl: `https://www.youtube.com/watch?v=${id}`,
  };
}

function vimeo(url: URL): VideoEmbed | null {
  const host = url.hostname.replace(/^www\./, '');
  if (host !== 'vimeo.com' && host !== 'player.vimeo.com') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  // vimeo.com/<id>[/<hash>], vimeo.com/channels/<name>/<id>, player.vimeo.com/video/<id>
  const index = parts.findIndex((part) => VIMEO_ID.test(part));
  const id = index >= 0 ? parts[index] : undefined;
  if (!id) return null;
  const hash = url.searchParams.get('h') ?? (parts[index + 1] && VIMEO_HASH.test(parts[index + 1]!) ? parts[index + 1]! : null);
  const params = new URLSearchParams({ dnt: '1', autoplay: '1' });
  if (hash && VIMEO_HASH.test(hash)) params.set('h', hash);
  const hashPath = hash && VIMEO_HASH.test(hash) ? `/${hash}` : '';
  return {
    site: 'Vimeo',
    embedUrl: `https://player.vimeo.com/video/${id}?${params.toString()}`,
    watchUrl: `https://vimeo.com/${id}${hashPath}`,
  };
}

/** The embed of a video setting; null for anything but an https YouTube or Vimeo address. */
export function videoEmbed(value: unknown): VideoEmbed | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return youtube(url) ?? vimeo(url);
}
