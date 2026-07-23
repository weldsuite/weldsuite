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

export default function VideoSection({
  url = "",
  title,
  autoplay = false,
  loop = false,
  muted = true,
  store,
  settings
}: VideoSectionProps) {
  // Check if it's a YouTube or Vimeo URL
  const isYouTube = url.includes('youtube.com') || url.includes('youtu.be');
  const isVimeo = url.includes('vimeo.com');
  
  const getEmbedUrl = () => {
    if (isYouTube) {
      const videoId = url.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/)?.[1];
      return videoId ? `https://www.youtube.com/embed/${videoId}${autoplay ? '?autoplay=1' : ''}${loop ? '&loop=1' : ''}${muted ? '&mute=1' : ''}` : '';
    }
    if (isVimeo) {
      const videoId = url.match(/vimeo\.com\/(\d+)/)?.[1];
      return videoId ? `https://player.vimeo.com/video/${videoId}${autoplay ? '?autoplay=1' : ''}${loop ? '&loop=1' : ''}${muted ? '&muted=1' : ''}` : '';
    }
    return url;
  };

  const embedUrl = getEmbedUrl();

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