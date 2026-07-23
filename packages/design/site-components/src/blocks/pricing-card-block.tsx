"use client";

import React from 'react';

export interface PricingCardBlockProps {
  title?: string;
  price?: string;
  currency?: string;
  period?: string;
  features?: string[];
  ctaText?: string;
  ctaUrl?: string;
  highlighted?: boolean;
  backgroundColor?: string;
  textColor?: string;
  accentColor?: string;
  mode?: 'live' | 'preview';
}

export function PricingCardBlock({
  title = 'Pro Plan',
  price = '29',
  currency = '$',
  period = 'month',
  features = [
    'Feature 1',
    'Feature 2',
    'Feature 3',
    'Feature 4',
  ],
  ctaText = 'Get Started',
  ctaUrl = '#',
  highlighted = false,
  backgroundColor = '#ffffff',
  textColor = '#000000',
  accentColor = '#3b82f6',
  mode = 'live'
}: PricingCardBlockProps) {
  return (
    <div
      className={`rounded-lg shadow-lg p-8 max-w-sm ${highlighted ? 'ring-4' : ''}`}
      style={{
        backgroundColor,
        borderColor: highlighted ? accentColor : 'transparent',
      }}
    >
      {highlighted && (
        <div
          className="text-center font-semibold text-sm uppercase mb-4 py-1"
          style={{ color: accentColor }}
        >
          Most Popular
        </div>
      )}

      <h3 className="text-2xl font-bold mb-2" style={{ color: textColor }}>
        {title}
      </h3>

      <div className="mb-6">
        <span className="text-4xl font-bold" style={{ color: textColor }}>
          {currency}{price}
        </span>
        <span className="text-gray-500">/{period}</span>
      </div>

      <ul className="space-y-3 mb-8">
        {features.map((feature, index) => (
          <li key={index} className="flex items-start gap-2">
            <svg
              className="w-5 h-5 mt-0.5 flex-shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              style={{ color: accentColor }}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
            <span style={{ color: textColor }}>{feature}</span>
          </li>
        ))}
      </ul>

      <a
        href={ctaUrl}
        className="block w-full text-center font-medium py-3 rounded-lg transition-opacity hover:opacity-90"
        style={{
          backgroundColor: accentColor,
          color: '#ffffff',
          textDecoration: 'none',
        }}
      >
        {ctaText}
      </a>
    </div>
  );
}
