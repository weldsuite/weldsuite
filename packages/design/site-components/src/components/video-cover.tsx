import React from 'react';

// Cover image with a play button, shown before the video starts.
interface VideoCoverProps {
  coverImage: string;
  heading?: string;
  onPlay: () => void;
}

export function VideoCover({ coverImage, heading, onPlay }: VideoCoverProps) {
  return (
    <div className="relative w-full h-full">
      <img
        src={coverImage}
        alt={heading || 'Video cover'}
        className="w-full h-full object-cover"
      />
      <button
        onClick={onPlay}
        className="absolute inset-0 flex items-center justify-center group"
        aria-label="Play video"
      >
        <div className="w-20 h-20 bg-white/90 rounded-full flex items-center justify-center group-hover:bg-white transition-colors">
          <svg className="w-10 h-10 text-black ml-1" fill="currentColor" viewBox="0 0 24 24">
            <path d="M8 5v14l11-7z" />
          </svg>
        </div>
      </button>
    </div>
  );
}
