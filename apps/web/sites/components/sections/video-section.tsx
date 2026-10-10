"use client";

interface VideoSectionProps {
  url?: string;
  title?: string;
  autoplay?: boolean;
  loop?: boolean;
  muted?: boolean;
  store?: any;
  settings?: any;
}

interface EmbedOptions {
  isYouTube: boolean;
  isVimeo: boolean;
  autoplay: boolean;
  loop: boolean;
  muted: boolean;
}

// Query-string suffix shared by the YouTube/Vimeo embeds. Kept byte-for-byte
// identical to the previous inline template literals (including the "&" join
// even when no "?autoplay=1" precedes it).
function embedQuery(
  { autoplay, loop, muted }: Pick<EmbedOptions, "autoplay" | "loop" | "muted">,
  muteParam: string
): string {
  return `${autoplay ? '?autoplay=1' : ''}${loop ? '&loop=1' : ''}${muted ? muteParam : ''}`;
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

function getEmbedUrl(url: string, options: EmbedOptions): string {
  if (options.isYouTube) {
    const videoId = youTubeVideoId(url);
    return videoId ? `https://www.youtube.com/embed/${videoId}${embedQuery(options, '&mute=1')}` : '';
  }
  if (options.isVimeo) {
    const videoId = /vimeo\.com\/(\d+)/.exec(url)?.[1];
    return videoId ? `https://player.vimeo.com/video/${videoId}${embedQuery(options, '&muted=1')}` : '';
  }
  return url;
}

export default function VideoSection({
  url = "",
  title,
  autoplay = false,
  loop = false,
  muted = true,
  store,
  settings
}: Readonly<VideoSectionProps>) {
  // Check if it's a YouTube or Vimeo URL
  const isYouTube = url.includes('youtube.com') || url.includes('youtu.be');
  const isVimeo = url.includes('vimeo.com');
  
  const embedUrl = getEmbedUrl(url, { isYouTube, isVimeo, autoplay, loop, muted });

  if (!embedUrl) {
    return (
      <section className="py-12 px-4">
        <div className="container mx-auto text-center">
          <p className="text-muted-foreground">No video URL provided</p>
        </div>
      </section>
    );
  }

  return (
    <section className="py-12 px-4">
      <div className="container mx-auto">
        {title && (
          <h2 className="text-3xl font-bold text-center mb-8">{title}</h2>
        )}
        <div className="aspect-video relative">
          {isYouTube || isVimeo ? (
            <iframe
              src={embedUrl}
              title={title ? title : 'Embedded video'}
              className="absolute inset-0 w-full h-full"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          ) : (
            <video
              src={embedUrl}
              className="w-full h-full object-cover"
              autoPlay={autoplay}
              loop={loop}
              muted={muted}
              controls
            />
          )}
        </div>
      </div>
    </section>
  );
}