"use client";

import React from 'react';
import { ChevronRight } from 'lucide-react';

export interface SlideButtonBlockProps {
  text?: string;
  link?: string;
  backgroundColor?: string;
  textColor?: string;
  fontSize?: number;
  showIcon?: boolean;
  mode?: 'live' | 'edit' | 'preview';
}

export function SlideButtonBlock({
  text = 'Shop Now',
  link = '/collections/all',
  backgroundColor = '#ffffff',
  textColor = '#111827',
  fontSize = 18,
  showIcon = true,
  mode = 'live',
}: SlideButtonBlockProps) {
  const isEditing = mode === 'edit' || mode === 'preview';

  return (
    <div className="transition-all duration-700">
      <a
        href={isEditing ? undefined : link}
        onClick={(e) => isEditing && e.preventDefault()}
        className="inline-flex items-center px-8 py-4 rounded-md font-semibold transition-all shadow-xl hover:shadow-2xl hover:scale-105 active:scale-95"
        style={{
          backgroundColor,
          color: textColor,
          fontSize: `${fontSize}px`
        }}
      >
        {text}
        {showIcon && <ChevronRight className="ml-2 w-5 h-5" />}
      </a>
    </div>
  );
}
