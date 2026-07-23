"use client";

import React from 'react';

interface MultirowItem {
  image: string;
  heading: string;
  link: string;
}

interface MultirowSectionProps {
  rows?: MultirowItem[];
  backgroundColor?: string;
  paddingTop?: number;
  paddingBottom?: number;
  rowSpacing?: number;
}

export function MultirowSection({
  rows = [
    { image: 'https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=800&h=400&fit=crop', heading: 'Category 1', link: '/category-1' },
    { image: 'https://images.unsplash.com/photo-1441984904996-e0b6ba687e04?w=800&h=400&fit=crop', heading: 'Category 2', link: '/category-2' },
    { image: 'https://images.unsplash.com/photo-1483985988355-763728e1935b?w=800&h=400&fit=crop', heading: 'Category 3', link: '/category-3' }
  ],
  backgroundColor = '#ffffff',
  paddingTop = 60,
  paddingBottom = 60,
  rowSpacing = 16,
}: MultirowSectionProps) {
  return (
    <section
      className="px-4 md:px-8"
      style={{
        backgroundColor,
        paddingTop: `${paddingTop}px`,
        paddingBottom: `${paddingBottom}px`
      }}
    >
      <div className="max-w-[1400px] mx-auto">
        <div
          className="flex flex-col"
          style={{ gap: `${rowSpacing}px` }}
        >
          {rows.map((row, index) => (
            <a
              key={index}
              href={row.link}
              className="group relative aspect-[21/9] overflow-hidden bg-gray-100 rounded-lg"
            >
              <img
                src={row.image}
                alt={row.heading}
                className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
              />
              <div className="absolute inset-0 bg-black/20 group-hover:bg-black/30 transition-colors" />
              <div className="absolute inset-0 flex items-center justify-center">
                <h3 className="text-4xl md:text-5xl font-bold text-white tracking-tight">
                  {row.heading}
                </h3>
              </div>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}
