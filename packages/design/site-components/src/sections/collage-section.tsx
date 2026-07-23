"use client";

import React from 'react';

interface CollageImage {
  url: string;
  link: string;
}

interface CollageSectionProps {
  images?: CollageImage[];
  columns?: number;
  spacing?: number;
  paddingTop?: number;
  paddingBottom?: number;
  backgroundColor?: string;
}

export function CollageSection({
  images = [
    { url: 'https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=400&h=400&fit=crop', link: '/collections/1' },
    { url: 'https://images.unsplash.com/photo-1441984904996-e0b6ba687e04?w=400&h=400&fit=crop', link: '/collections/2' },
    { url: 'https://images.unsplash.com/photo-1483985988355-763728e1935b?w=400&h=400&fit=crop', link: '/collections/3' },
    { url: 'https://images.unsplash.com/photo-1490481651871-ab68de25d43d?w=400&h=400&fit=crop', link: '/collections/4' }
  ],
  columns = 2,
  spacing = 16,
  paddingTop = 60,
  paddingBottom = 60,
  backgroundColor = '#ffffff',
}: CollageSectionProps) {
  return (
    <section
      className="px-4 md:px-8"
      style={{
        backgroundColor,
        paddingTop: `${paddingTop}px`,
        paddingBottom: `${paddingBottom}px`
      }}
    >
      <div className="container mx-auto" style={{ maxWidth: '1400px' }}>
        <div
          className="grid"
          style={{
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            gap: `${spacing}px`
          }}
        >
          {images.map((image, index) => (
            <a
              key={index}
              href={image.link}
              className="group relative aspect-square overflow-hidden bg-gray-100"
            >
              <img
                src={image.url}
                alt={`Collection ${index + 1}`}
                className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110"
              />
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}
