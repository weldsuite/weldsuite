// Shared embed-URL builder for the video block and video section.

export interface EmbedOptions {
  url: string;
  isYouTube: boolean;
  isVimeo: boolean;
  autoplay: boolean;
  loop: boolean;
  muted: boolean;
  showControls: boolean;
}

/** `youtube.com/embed/ID`, `/v/ID`, `/e/ID`, `/<path>/ID` and `…?v=ID` / `…&v=ID`. */
const YOUTUBE_COM_ID = /youtube\.com\/(?:[^/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)([^"&?/\s]{11})/;
/** `youtu.be/ID` short links. */
const YOUTU_BE_ID = /youtu\.be\/([^"&?/\s]{11})/;

/** The 11-character video id of whichever YouTube URL form appears first in `url`. */
function youTubeVideoId(url: string): string | undefined {
  const long = YOUTUBE_COM_ID.exec(url);
  const short = YOUTU_BE_ID.exec(url);
  if (long && short) return (long.index < short.index ? long : short)[1];
  return (long ?? short)?.[1];
}

function buildYouTubeUrl(url: string, { autoplay, loop, muted, showControls }: EmbedOptions): string {
  const videoId = youTubeVideoId(url);
  if (!videoId) return '';

  const params = new URLSearchParams();
  if (autoplay) params.set('autoplay', '1');
  if (loop) {
    params.set('loop', '1');
    params.set('playlist', videoId);
  }
  if (muted) params.set('mute', '1');
  if (!showControls) params.set('controls', '0');
  params.set('rel', '0');

  return `https://www.youtube.com/embed/${videoId}?${params.toString()}`;
}

function buildVimeoUrl(url: string, { autoplay, loop, muted, showControls }: EmbedOptions): string {
  const videoId = /vimeo\.com\/(\d+)/.exec(url)?.[1];
  if (!videoId) return '';

  const params = new URLSearchParams();
  if (autoplay) params.set('autoplay', '1');
  if (loop) params.set('loop', '1');
  if (muted) params.set('muted', '1');
  if (!showControls) params.set('controls', '0');

  return `https://player.vimeo.com/video/${videoId}?${params.toString()}`;
}

export function buildEmbedUrl(options: EmbedOptions): string {
  if (options.isYouTube) return buildYouTubeUrl(options.url, options);
  if (options.isVimeo) return buildVimeoUrl(options.url, options);
  return options.url;
}
