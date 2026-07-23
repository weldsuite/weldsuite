"use client";

import React from 'react';
import { DynamicIcon } from 'lucide-react/dynamic';
import { Truck, RotateCcw, Shield, Star } from 'lucide-react';

function toKebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

interface TrustItem {
  id: string;
  icon: string;
  title: string;
  description?: string;
}

export interface TrustStripBlockProps {
  items?: TrustItem[];
  backgroundColor?: string;
  textColor?: string;
  iconColor?: string;
  iconBackgroundColor?: string;
  iconBorderRadius?: number;
  alignment?: 'left' | 'center' | 'right';
  itemGap?: number;
  showDescriptions?: boolean;
  mode?: 'live' | 'preview' | 'edit';
}

const DEFAULT_ITEMS: TrustItem[] = [
  {
    id: 'shipping',
    icon: 'Truck',
    title: 'Free Shipping',
    description: 'On orders over $50',
  },
  {
    id: 'returns',
    icon: 'RotateCcw',
    title: 'Easy Returns',
    description: '30-day return policy',
  },
  {
    id: 'secure',
    icon: 'Shield',
    title: 'Secure Payment',
    description: '100% protected',
  },
  {
    id: 'rating',
    icon: 'Star',
    title: '4.9/5 Rating',
    description: 'From 10,000+ reviews',
  },
];

export function TrustStripBlock({
  items = DEFAULT_ITEMS,
  backgroundColor = '#fafafa',
  textColor = '#171717',
  iconColor = '#171717',
  iconBackgroundColor = '#e5e5e5',
  iconBorderRadius = 8,
  alignment = 'center',
  itemGap = 24,
  showDescriptions = true,
  mode = 'live',
}: TrustStripBlockProps) {
  // Icon mapping function - dynamically resolve any Lucide icon (per-icon
  // chunk via lucide-react/dynamic). Falls back to Star when the name is
  // missing or unknown.
  const getIcon = (iconName: string) => {
    if (!iconName) return <Star className="size-5" />;
    const kebab = (iconName.includes('-') ? iconName : toKebab(iconName)).toLowerCase();
    return (
      <DynamicIcon
        name={kebab as never}
        className="size-5"
        fallback={() => <Star className="size-5" />}
      />
    );
  };

  return (
    <section
      className="border-y py-6"
      style={{ backgroundColor }}
    >
      <div className="max-w-7xl mx-auto px-4">
        <div
          className={`grid ${
            items.length === 1 ? 'grid-cols-1' :
            items.length === 2 ? 'grid-cols-2' :
            items.length === 3 ? 'grid-cols-3' :
            'grid-cols-2 md:grid-cols-4'
          } ${
            alignment === 'left' ? 'justify-items-start' :
            alignment === 'right' ? 'justify-items-end' :
            'justify-items-center'
          }`}
          style={{ gap: itemGap }}
        >
          {items.map((item, index) => (
            <div key={item.id || index} className="flex items-center gap-3">
              <div
                className="flex size-10 shrink-0 items-center justify-center"
                style={{ backgroundColor: iconBackgroundColor, color: iconColor, borderRadius: iconBorderRadius }}
              >
                {getIcon(item.icon)}
              </div>
              <div>
                <p
                  className="font-medium leading-tight"
                  style={{ color: textColor }}
                >
                  {item.title}
                </p>
                {showDescriptions && item.description && (
                  <p
                    className="text-sm opacity-70"
                    style={{ color: textColor }}
                  >
                    {item.description}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
