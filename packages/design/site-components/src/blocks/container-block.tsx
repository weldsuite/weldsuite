"use client";

import React from 'react';

interface ContainerBlockProps {
  children?: React.ReactNode;
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | 'full';
  contentWidth?: 'narrow' | 'default' | 'wide' | 'full';
  alignment?: 'left' | 'center' | 'right';
  paddingX?: number;
  paddingY?: number;
  padding?: number;
  backgroundColor?: string;
  borderRadius?: number;
  border?: boolean;
  borderColor?: string;
  borderWidth?: number;
  mode?: string;
}

export function ContainerBlock({
  children,
  maxWidth,
  contentWidth = 'default',
  alignment = 'left',
  paddingX,
  paddingY,
  padding = 16,
  backgroundColor = 'transparent',
  borderRadius = 0,
  border = false,
  borderColor = '#e5e7eb',
  borderWidth = 1,
  mode = 'live'
}: ContainerBlockProps) {
  // Use contentWidth if provided, otherwise fall back to maxWidth for backward compatibility
  const widthSetting = contentWidth || (maxWidth && {
    sm: 'narrow',
    md: 'narrow',
    lg: 'default',
    xl: 'default',
    '2xl': 'wide',
    full: 'full',
  }[maxWidth]) || 'default';

  const maxWidthClass = {
    narrow: 'max-w-2xl',      // 672px - good for reading text
    default: 'max-w-7xl',      // 1280px - standard content width
    wide: 'max-w-[1536px]',    // 1536px - wide layouts
    full: 'max-w-full',        // 100% - full width
  }[widthSetting];

  const alignmentClass = {
    left: 'mx-0 ml-0',
    center: 'mx-auto',
    right: 'mx-0 ml-auto',
  }[alignment];

  const horizontalPadding = paddingX !== undefined ? paddingX : padding;
  const verticalPadding = paddingY !== undefined ? paddingY : padding;

  // Outer wrapper with horizontal margin to control background width, inner wrapper for content
  return (
    <div
      style={{
        backgroundColor,
        borderRadius: `${borderRadius}px`,
        border: border ? `${borderWidth}px solid ${borderColor}` : 'none',
        marginLeft: `${horizontalPadding}px`,
        marginRight: `${horizontalPadding}px`,
      }}
    >
      <div
        className={`${maxWidthClass} ${alignmentClass} w-full`}
        style={{
          paddingTop: `${verticalPadding}px`,
          paddingBottom: `${verticalPadding}px`,
        }}
      >
        {children}
      </div>
    </div>
  );
}
