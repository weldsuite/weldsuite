"use client";

import React from 'react';

export interface QuoteBlockProps {
  quote?: string;
  citation?: string;
  author?: string;
  borderStyle?: 'left' | 'left-accent' | 'full' | 'none';
  backgroundColor?: string;
  textColor?: string;
  borderColor?: string;
  fontSize?: 'sm' | 'md' | 'lg' | 'xl';
  fontStyle?: 'normal' | 'italic';
  mode?: 'live' | 'preview';
}

export function QuoteBlock({
  quote = 'The best way to predict the future is to invent it.',
  citation,
  author = 'Alan Kay',
  borderStyle = 'left-accent',
  backgroundColor = '#f9fafb',
  textColor = '#1f2937',
  borderColor = '#3b82f6',
  fontSize = 'lg',
  fontStyle = 'italic',
  mode = 'live'
}: QuoteBlockProps) {
  const fontSizeClasses = {
    sm: 'text-base',
    md: 'text-lg',
    lg: 'text-xl',
    xl: 'text-2xl',
  }[fontSize];

  const fontStyleClass = fontStyle === 'italic' ? 'italic' : '';

  const borderStyles = {
    left: {
      borderLeft: `4px solid ${borderColor}`,
    },
    'left-accent': {
      borderLeft: `6px solid ${borderColor}`,
    },
    full: {
      border: `2px solid ${borderColor}`,
    },
    none: {},
  }[borderStyle];

  return (
    <blockquote
      className="p-6 rounded-lg max-w-3xl"
      style={{
        backgroundColor,
        ...borderStyles,
      }}
    >
      <div className="flex items-start gap-3">
        <svg
          className="w-8 h-8 flex-shrink-0 opacity-50"
          fill="currentColor"
          viewBox="0 0 24 24"
          style={{ color: borderColor }}
        >
          <path d="M14.017 21v-7.391c0-5.704 3.731-9.57 8.983-10.609l.995 2.151c-2.432.917-3.995 3.638-3.995 5.849h4v10h-9.983zm-14.017 0v-7.391c0-5.704 3.748-9.57 9-10.609l.996 2.151c-2.433.917-3.996 3.638-3.996 5.849h3.983v10h-9.983z" />
        </svg>
        <div className="flex-1">
          <p
            className={`${fontSizeClasses} ${fontStyleClass} mb-4`}
            style={{ color: textColor }}
          >
            {quote}
          </p>
          {(author || citation) && (
            <footer className="text-sm" style={{ color: textColor, opacity: 0.8 }}>
              {author && <cite className="font-semibold not-italic">— {author}</cite>}
              {citation && <span className="ml-2">({citation})</span>}
            </footer>
          )}
        </div>
      </div>
    </blockquote>
  );
}
