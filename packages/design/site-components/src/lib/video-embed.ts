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

function buildYouTubeUrl(url: string, { autoplay, loop, muted, showControls }: EmbedOptions): string {
  const videoId = url.match(/(?:youtube\.com\/(?:[^/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?/\s]{11})/)?.[1];
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
  const videoId = url.match(/vimeo\.com\/(\d+)/)?.[1];
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
