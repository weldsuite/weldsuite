"use client";

import React from 'react';

export interface BadgeBlockProps {
  text?: string;
  variant?: 'success' | 'warning' | 'error' | 'info' | 'neutral';
  size?: 'sm' | 'md' | 'lg';
  mode?: 'live' | 'preview';
}

export function BadgeBlock({
  text = 'Badge',
  variant = 'neutral',
  size = 'md',
  mode = 'live'
}: BadgeBlockProps) {
  const sizeClasses = {
    sm: 'px-2 py-0.5 text-xs',
    md: 'px-3 py-1 text-sm',
    lg: 'px-4 py-1.5 text-base',
  }[size];

  const variantStyles = {
    success: {
      backgroundColor: '#dcfce7',
      color: '#166534',
    },
    warning: {
      backgroundColor: '#fef3c7',
      color: '#92400e',
    },
    error: {
      backgroundColor: '#fee2e2',
      color: '#991b1b',
    },
    info: {
      backgroundColor: '#dbeafe',
      color: '#1e40af',
    },
    neutral: {
      backgroundColor: '#f3f4f6',
      color: '#374151',
    },
  }[variant];

  return (
    <span
      className={`inline-flex items-center rounded-full font-medium ${sizeClasses}`}
      style={variantStyles}
    >
      {text}
    </span>
  );
}
