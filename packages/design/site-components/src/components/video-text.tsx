"use client";

import React, { useRef, useEffect, useState } from "react";
import { cn } from "@weldsuite/ui/lib/utils";

interface VideoTextProps {
  src: string;
  children: React.ReactNode;
  className?: string;
  fontFamily?: string;
  fontSize?: string;
  style?: React.CSSProperties;
}

export function VideoText({ src, children, className, fontFamily = "sans-serif", fontSize = "200px", style }: VideoTextProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isVideoReady, setIsVideoReady] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleCanPlay = () => {
      setIsVideoReady(true);
      video.play().catch(() => {});
    };

    video.addEventListener('canplay', handleCanPlay);

    // Check if already ready
    if (video.readyState >= 3) {
      setIsVideoReady(true);
      video.play().catch(() => {});
    }

    return () => video.removeEventListener('canplay', handleCanPlay);
  }, []);

  return (
    <div
      ref={containerRef}
      className={cn("relative w-full h-full flex items-center justify-center overflow-hidden", className)}
    >
      {/* Video background (hidden, used for clip effect) */}
      <video
        ref={videoRef}
        src={src}
        muted
        loop
        playsInline
        preload="auto"
        className="absolute border-0"
        style={{
          top: '-2px',
          left: '-2px',
          width: 'calc(100% + 4px)',
          height: 'calc(100% + 4px)',
          objectFit: 'cover',
          opacity: isVideoReady ? 1 : 0,
          transition: 'opacity 0.3s ease',
          border: 'none',
          outline: 'none',
        }}
      />

      {/* Text overlay that masks the video */}
      <div
        className="relative z-10 w-full h-full flex items-center justify-center pointer-events-none px-8"
        style={{
          mixBlendMode: 'screen',
          backgroundColor: '#fff',
        }}
      >
        <span
          className="text-center font-bold tracking-tighter select-none caret-transparent"
          style={{
            fontFamily,
            fontSize: 'clamp(3rem, 15vw, 12rem)',
            letterSpacing: '-0.05em',
            lineHeight: 1,
            color: '#000',
            userSelect: 'none',
            ...style,
          }}
        >
          {children}
        </span>
      </div>

      {/* Fallback gradient text when video not ready */}
      {!isVideoReady && (
        <div className="absolute inset-0 flex items-center justify-center px-8">
          <span
            className="text-center font-bold tracking-tighter select-none caret-transparent"
            style={{
              fontFamily,
              fontSize: 'clamp(3rem, 15vw, 12rem)',
              letterSpacing: '-0.05em',
              lineHeight: 1,
              background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
              WebkitBackgroundClip: 'text',
              backgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              color: 'transparent',
              userSelect: 'none',
              ...style,
            }}
          >
            {children}
          </span>
        </div>
      )}
    </div>
  );
}
