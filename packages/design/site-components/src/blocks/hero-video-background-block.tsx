"use client";

import React from 'react';

export interface HeroVideoBackgroundBlockProps {
  videoUrl?: string;
  backgroundImageUrl?: string;
  text?: string;
  fontFamily?: string;
  fontSize?: string;
  backgroundOpacity?: number;
  minHeight?: string;
  mode?: 'live' | 'edit' | 'preview';
}

export function HeroVideoBackgroundBlock({
  videoUrl = "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/landscape.mp4",
  backgroundImageUrl = "https://deifkwefumgah.cloudfront.net/shadcnblocks/block/lummi/landscape6.jpeg",
  text = "Blocks",
  fontFamily = "Playfair Display, serif",
  fontSize = "clamp(4rem, 15vw, 15rem)",
  backgroundOpacity = 20,
  minHeight = "100vh",
  mode = 'live',
}: HeroVideoBackgroundBlockProps) {
  const [isLoaded, setIsLoaded] = React.useState(false);

  return (
    <section
      className="relative flex flex-col items-center justify-center overflow-hidden py-32"
      style={{ minHeight }}
    >
      <div className="container mx-auto px-4">
        {/* Background image with opacity */}
        <div
          className="absolute left-0 top-0 h-full w-full overflow-hidden bg-cover bg-top bg-no-repeat"
          style={{
            backgroundImage: `url('${backgroundImageUrl}')`,
            opacity: backgroundOpacity / 100,
          }}
        />

        <div className="flex flex-col items-center justify-center gap-4">
          {/* Video Text Container */}
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
              {/* Hidden video to load */}
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
        </div>
      </div>
    </section>
  );
}
