"use client";

import React from 'react';

export interface FlexBlockProps {
  direction?: 'row' | 'column';
  justify?: 'start' | 'center' | 'end' | 'between' | 'around';
  align?: 'start' | 'center' | 'end' | 'stretch';
  wrap?: boolean;
  gap?: number;
  contentWidth?: 'narrow' | 'default' | 'wide' | 'full';
  paddingX?: number;
  paddingY?: number;
  backgroundColor?: string;
  borderColor?: string;
  borderWidth?: number;
  borderRadius?: number;
  children?: React.ReactNode;
  mode?: 'live' | 'preview';
}

export function FlexBlock({
  direction = 'row',
  justify = 'start',
  align = 'start',
  wrap = false,
  gap = 16,
  contentWidth = 'full',
  paddingX = 0,
  paddingY = 0,
  backgroundColor,
  borderColor,
  borderWidth = 1,
  borderRadius = 8,
  children,
  mode = 'live'
}: FlexBlockProps) {
  const directionClass = direction === 'row' ? 'flex-row' : 'flex-col';

  const justifyClass = {
    start: 'justify-start',
    center: 'justify-center',
    end: 'justify-end',
    between: 'justify-between',
    around: 'justify-around',
  }[justify];

  const alignClass = {
    start: 'items-start',
    center: 'items-center',
    end: 'items-end',
    stretch: 'items-stretch',
  }[align];

  const widthClass = {
    narrow: 'max-w-2xl',
    default: 'max-w-7xl',
    wide: 'max-w-[1536px]',
    full: 'max-w-full',
  }[contentWidth];

  const wrapClass = wrap ? 'flex-wrap' : '';

  return (
    <div
      className={`flex ${directionClass} ${justifyClass} ${alignClass} ${wrapClass} ${widthClass} w-full mx-auto`}
      style={{
        gap: `${gap}px`,
        paddingLeft: `${paddingX}px`,
        paddingRight: `${paddingX}px`,
        paddingTop: `${paddingY}px`,
        paddingBottom: `${paddingY}px`,
        overflow: 'visible',
        backgroundColor,
        borderColor,
        borderWidth: borderColor ? `${borderWidth}px` : undefined,
        borderStyle: borderColor ? 'solid' : undefined,
        borderRadius: (backgroundColor || borderColor) ? `${borderRadius}px` : undefined,
      }}
    >
      {children || (
        <>
          <div className="bg-gray-100 rounded-lg p-6 text-center text-gray-500">Item 1</div>
          <div className="bg-gray-100 rounded-lg p-6 text-center text-gray-500">Item 2</div>
          <div className="bg-gray-100 rounded-lg p-6 text-center text-gray-500">Item 3</div>
        </>
      )}
    </div>
  );
}
