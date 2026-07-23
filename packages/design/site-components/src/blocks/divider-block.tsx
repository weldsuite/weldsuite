"use client";

import React from 'react';

interface DividerBlockProps {
  style?: 'solid' | 'dashed' | 'dotted';
  thickness?: number;
  color?: string;
  width?: number;
  alignment?: 'left' | 'center' | 'right';
  mode?: string;
}

export function DividerBlock({
  style = 'solid',
  thickness = 1,
  color = '#e5e7eb',
  width = 100,
  alignment = 'center',
  mode = 'live'
}: DividerBlockProps) {
  const alignmentClass = {
    left: 'mr-auto',
    center: 'mx-auto',
    right: 'ml-auto',
  }[alignment];

  return (
    <hr
      className={alignmentClass}
      style={{
        borderStyle: style,
        borderWidth: `${thickness}px 0 0 0`,
        borderColor: color,
        width: `${width}%`,
        margin: '0',
      }}
    />
  );
}
