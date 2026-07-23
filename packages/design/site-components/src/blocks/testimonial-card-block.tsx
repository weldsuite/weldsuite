"use client";

import React from 'react';

export interface TestimonialCardBlockProps {
  quote?: string;
  authorName?: string;
  authorRole?: string;
  avatarUrl?: string;
  rating?: number;
  backgroundColor?: string;
  textColor?: string;
  mode?: 'live' | 'preview';
}

export function TestimonialCardBlock({
  quote = 'This is an amazing product! It has completely transformed the way we work.',
  authorName = 'John Doe',
  authorRole = 'CEO, Company Inc.',
  avatarUrl = 'https://via.placeholder.com/64',
  rating = 5,
  backgroundColor = '#ffffff',
  textColor = '#000000',
  mode = 'live'
}: TestimonialCardBlockProps) {
  return (
    <div
      className="rounded-lg shadow-lg p-6 max-w-2xl"
      style={{ backgroundColor }}
    >
      {rating > 0 && (
        <div className="flex gap-1 mb-4">
          {Array.from({ length: 5 }).map((_, index) => (
            <svg
              key={index}
              className="w-5 h-5"
              fill={index < rating ? '#fbbf24' : '#d1d5db'}
              viewBox="0 0 20 20"
            >
              <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
            </svg>
          ))}
        </div>
      )}

      <blockquote className="mb-6">
        <p className="text-lg italic" style={{ color: textColor }}>
          "{quote}"
        </p>
      </blockquote>

      <div className="flex items-center gap-4">
        <img
          src={avatarUrl}
          alt={authorName}
          className="w-12 h-12 rounded-full object-cover"
        />
        <div>
          <p className="font-semibold" style={{ color: textColor }}>
            {authorName}
          </p>
          <p className="text-sm opacity-70" style={{ color: textColor }}>
            {authorRole}
          </p>
        </div>
      </div>
    </div>
  );
}
