"use client";

import React from 'react';

export interface SlideHeadingBlockProps {
  content?: string;
  fontSize?: number;
  fontWeight?: number;
  color?: string;
  mode?: 'live' | 'edit' | 'preview';
}

export function SlideHeadingBlock({
  content = 'Slide Heading',
  fontSize = 64,
  fontWeight = 700,
  color = '#ffffff',
  mode = 'live',
}: SlideHeadingBlockProps) {
  return (
    <h2
      className="mb-4 md:mb-6 transition-all duration-700"
      style={{
        fontSize: `${fontSize}px`,
        fontWeight,
        color,
        lineHeight: '1.1',
        letterSpacing: '-0.02em',
        textShadow: '0 2px 20px rgba(0,0,0,0.3)'
      }}
    >
      {content}
    </h2>
  );
}
