import React from 'react';
import { VideoCover } from './video-cover';

interface VideoMediaProps {
  /** Show the cover image (with a play button) instead of the player. */
  showCover: boolean;
  coverImage?: string;
  heading?: string;
  onPlay: () => void;
  /** YouTube / Vimeo URLs play in an iframe; anything else in a <video>. */
  isEmbed: boolean;
  embedUrl: string;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  autoplay?: boolean;
  loop?: boolean;
  muted?: boolean;
  controls?: boolean;
}

/** The media area shared by the video section and the video player block. */
export function VideoMedia({
  showCover,
  coverImage,
  heading,
  onPlay,
  isEmbed,
  embedUrl,
  videoRef,
  autoplay,
  loop,
  muted,
  controls,
}: Readonly<VideoMediaProps>) {
  if (showCover && coverImage) {
    return <VideoCover coverImage={coverImage} heading={heading} onPlay={onPlay} />;
  }
  if (isEmbed) {
    return (
      <iframe
        src={embedUrl}
        className="absolute inset-0 w-full h-full"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
        title={heading || 'Video'}
      />
    );
  }
  return (
    <video
      ref={videoRef}
      src={embedUrl}
      className="w-full h-full object-cover"
      autoPlay={autoplay}
      loop={loop}
      muted={muted}
      controls={controls}
      playsInline
    />
  );
}
