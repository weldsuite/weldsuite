"use client";

import React from 'react';

export interface GridBlockProps {
  columns?: number;
  gap?: number;
  mobileColumns?: number;
  tabletColumns?: number;
  children?: React.ReactNode;
  mode?: 'live' | 'preview';
}

export function GridBlock({
  columns = 3,
  gap = 16,
  mobileColumns = 1,
  tabletColumns = 2,
  children,
  mode = 'live'
}: GridBlockProps) {
  // Responsive grid classes
  const gridCols = {
    1: 'lg:grid-cols-1',
    2: 'lg:grid-cols-2',
    3: 'lg:grid-cols-3',
    4: 'lg:grid-cols-4',
    5: 'lg:grid-cols-5',
    6: 'lg:grid-cols-6',
  }[columns] || 'lg:grid-cols-3';

  const mobileCols = {
    1: 'grid-cols-1',
    2: 'grid-cols-2',
    3: 'grid-cols-3',
  }[mobileColumns] || 'grid-cols-1';

  const tabletCols = {
    1: 'md:grid-cols-1',
    2: 'md:grid-cols-2',
    3: 'md:grid-cols-3',
    4: 'md:grid-cols-4',
  }[tabletColumns] || 'md:grid-cols-2';

  const gapClass = `gap-${gap / 4}`; // Convert px to Tailwind spacing (16px = gap-4)

  return (
    <div className={`grid ${mobileCols} ${tabletCols} ${gridCols} ${gapClass}`}>
      {children || (
        <>
          {Array.from({ length: columns }).map((_, i) => (
            <div key={i} className="bg-gray-100 rounded-lg p-6 text-center text-gray-500">
              Grid Item {i + 1}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
