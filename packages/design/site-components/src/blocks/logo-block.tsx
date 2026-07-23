import React from 'react';

export interface LogoBlockProps {
  src?: string;
  alt?: string;
  width?: number;
  height?: number;
  link?: string;
  mode?: 'live' | 'preview';
}

export function LogoBlock({
  src = '',
  alt = 'Logo',
  width = 150,
  height = 50,
  link = '/',
  mode = 'live'
}: LogoBlockProps) {
  const logo = (
    <img
      src={src || 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="150" height="50"%3E%3Crect width="150" height="50" fill="%23e5e7eb"/%3E%3Ctext x="50%25" y="50%25" dominant-baseline="middle" text-anchor="middle" fill="%239ca3af" font-family="sans-serif" font-size="14"%3ELogo%3C/text%3E%3C/svg%3E'}
      alt={alt}
      width={width}
      height={height}
      className="object-contain"
    />
  );

  if (mode === 'preview') {
    return <div className="inline-block">{logo}</div>;
  }

  return (
    <a href={link} className="inline-block">
      {logo}
    </a>
  );
}
