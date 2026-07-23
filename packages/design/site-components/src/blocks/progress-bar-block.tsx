"use client";

import React from 'react';

export interface ProgressBarBlockProps {
  percentage?: number;
  label?: string;
  showPercentage?: boolean;
  color?: string;
  backgroundColor?: string;
  height?: 'sm' | 'md' | 'lg';
  animated?: boolean;
  striped?: boolean;
  mode?: 'live' | 'preview';
}

export function ProgressBarBlock({
  percentage = 75,
  label,
  showPercentage = true,
  color = '#3b82f6',
  backgroundColor = '#e5e7eb',
  height = 'md',
  animated = true,
  striped = false,
  mode = 'live'
}: ProgressBarBlockProps) {
  const clampedPercentage = Math.min(Math.max(percentage, 0), 100);

  const heightClasses = {
    sm: 'h-2',
    md: 'h-4',
    lg: 'h-6',
  }[height];

  return (
    <div className="w-full max-w-2xl">
      {label && (
        <div className="flex justify-between items-center mb-2">
          <span className="text-sm font-medium">{label}</span>
          {showPercentage && (
            <span className="text-sm font-medium">{clampedPercentage}%</span>
          )}
        </div>
      )}
      <div
        className={`w-full rounded-full overflow-hidden ${heightClasses}`}
        style={{ backgroundColor }}
      >
        <div
          className={`h-full transition-all duration-500 ${animated ? 'transition-all' : ''} ${
            striped ? 'bg-striped' : ''
          }`}
          style={{
            width: `${clampedPercentage}%`,
            backgroundColor: color,
            backgroundImage: striped
              ? 'linear-gradient(45deg, rgba(255,255,255,.15) 25%, transparent 25%, transparent 50%, rgba(255,255,255,.15) 50%, rgba(255,255,255,.15) 75%, transparent 75%, transparent)'
              : undefined,
            backgroundSize: striped ? '1rem 1rem' : undefined,
            animation: animated && striped ? 'progress-stripes 1s linear infinite' : undefined,
          }}
        />
      </div>
      <style jsx>{`
        @keyframes progress-stripes {
          0% {
            background-position: 1rem 0;
          }
          100% {
            background-position: 0 0;
          }
        }
      `}</style>
    </div>
  );
}
