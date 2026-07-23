"use client";

import React from 'react';

export interface SlideTextBlockProps {
  content?: string;
  fontSize?: number;
  color?: string;
  maxWidth?: number;
  mode?: 'live' | 'edit' | 'preview';
}

export function SlideTextBlock({
  content = 'Add your slide description here',
  fontSize = 24,
  color = '#ffffff',
  maxWidth = 672, // 2xl = 42rem = 672px
  mode = 'live',
}: SlideTextBlockProps) {
  return (
    <p
      className="mb-8 md:mb-10 transition-all duration-700"
      style={{
        fontSize: `${fontSize}px`,
        color: `${color}f2`, // 95% opacity
        maxWidth: `${maxWidth}px`,
        textShadow: '0 1px 10px rgba(0,0,0,0.3)'
      }}
    >
      {content}
    </p>
  );
}
