"use client";

import React from 'react';

export interface VideoTextBlockProps {
  videoUrl?: string;
  text?: string;
  fontFamily?: string;
  fontSize?: string;
  textColor?: string;
  mode?: 'live' | 'edit' | 'preview';
}

export function VideoTextBlock({
  videoUrl = "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/ocean1080.mov",
  text = "Blocks",
  fontFamily = "system-ui, sans-serif",
  fontSize = "clamp(4rem, 15vw, 15rem)",
  textColor = '#333',
  mode = 'live',
}: VideoTextBlockProps) {
  const [isLoaded, setIsLoaded] = React.useState(false);

  return (
    <div
      className="relative flex w-full items-center justify-center"
      style={{
        opacity: isLoaded ? 1 : 0,
        transform: isLoaded ? 'scale(1)' : 'scale(1.1)',
        transition: 'opacity 0.3s ease, transform 0.3s ease',
      }}
    >
      <div className="relative inline-block">
        {/* Text with video background clipped to it */}
        <h1
          className="font-bold tracking-tighter"
          style={{
            fontFamily,
            fontSize,
            lineHeight: 1,
            backgroundImage: `url(${videoUrl})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
            color: 'transparent',
            WebkitTextFillColor: 'transparent',
          }}
        >
          {text}
        </h1>
        {/* Hidden video to load and provide animation */}
        <video
          src={videoUrl}
          autoPlay
          loop
          muted
          playsInline
          onLoadedData={() => setIsLoaded(true)}
          className="absolute top-0 left-0 w-full h-full object-cover pointer-events-none"
          style={{
            WebkitMaskImage: `url("data:image/svg+xml,${encodeURIComponent(
              `<svg xmlns='http://www.w3.org/2000/svg'><text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' font-size='15rem' font-weight='bold' font-family='${fontFamily}'>${text}</text></svg>`
            )}")`,
            maskImage: `url("data:image/svg+xml,${encodeURIComponent(
              `<svg xmlns='http://www.w3.org/2000/svg'><text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' font-size='15rem' font-weight='bold' font-family='${fontFamily}'>${text}</text></svg>`
            )}")`,
            WebkitMaskSize: 'contain',
            maskSize: 'contain',
            WebkitMaskRepeat: 'no-repeat',
            maskRepeat: 'no-repeat',
            WebkitMaskPosition: 'center',
            maskPosition: 'center',
          }}
        />
      </div>
    </div>
  );
}
