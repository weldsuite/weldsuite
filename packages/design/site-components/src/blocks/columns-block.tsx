"use client";

import React from 'react';

interface ColumnsBlockProps {
  children?: React.ReactNode;
  columns?: 2 | 3 | 4;
  gap?: number;
  mode?: string;
}

export function ColumnsBlock({
  children,
  columns = 2,
  gap = 16,
  mode = 'live'
}: ColumnsBlockProps) {
  const gridColsClass = {
    2: 'grid-cols-1 md:grid-cols-2',
    3: 'grid-cols-1 md:grid-cols-3',
    4: 'grid-cols-1 md:grid-cols-2 lg:grid-cols-4',
  }[columns];

  return (
    <div
      className={`grid ${gridColsClass}`}
      style={{ gap: `${gap}px` }}
    >
      {children}
    </div>
  );
}
