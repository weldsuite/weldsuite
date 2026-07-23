import React from 'react';

export interface LinkBlockProps {
  text?: string;
  url?: string;
  variant?: 'text' | 'underline' | 'arrow';
  color?: string;
  fontSize?: string;
  fontWeight?: string;
  mode?: 'live' | 'preview';
}

export function LinkBlock({
  text = 'Link',
  url = '#',
  variant = 'text',
  color = '#000000',
  fontSize = 'base',
  fontWeight = 'normal',
  mode = 'live'
}: LinkBlockProps) {
  const sizeClass = {
    xs: 'text-xs',
    sm: 'text-sm',
    base: 'text-base',
    lg: 'text-lg',
    xl: 'text-xl',
    '2xl': 'text-2xl',
  }[fontSize] || 'text-base';

  const weightClass = {
    light: 'font-light',
    normal: 'font-normal',
    medium: 'font-medium',
    semibold: 'font-semibold',
    bold: 'font-bold',
  }[fontWeight] || 'font-normal';

  const variantClass = {
    text: 'hover:opacity-75',
    underline: 'underline hover:opacity-75',
    arrow: 'inline-flex items-center gap-2 hover:gap-3',
  }[variant];

  return (
    <a
      href={mode === 'live' ? url : '#'}
      className={`transition-all ${sizeClass} ${weightClass} ${variantClass}`}
      style={{ color }}
    >
      {text}
      {variant === 'arrow' && (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      )}
    </a>
  );
}
