"use client";

import React, { useState } from 'react';
import { ChevronRight } from 'lucide-react';

interface AccordionItem {
  id: string;
  title: string;
  content: string;
}

export interface ProductInfoAccordionBlockProps {
  items?: AccordionItem[];
  textColor?: string;
  borderColor?: string;
  mode?: 'live' | 'edit' | 'preview';
  store?: {
    selectedProduct?: any;
    [key: string]: any;
  };
}

const DEFAULT_ITEMS: AccordionItem[] = [
  {
    id: 'composition',
    title: 'Composition',
    content: 'Made from premium pebbled leather with a structured silhouette. Fully lined in soft cotton twill. Accented with brushed gold-tone hardware.',
  },
  {
    id: 'delivery',
    title: 'Delivery & Returns',
    content: 'Enjoy complimentary shipping and easy returns on all purchases. Orders within the U.S. typically ship within 5–7 business days.',
  },
  {
    id: 'dimensions',
    title: 'Dimensions',
    content: 'Height: 21 cm × Width: 28 cm (8.3" × 11") — comfortably fits daily essentials.',
  },
  {
    id: 'care',
    title: 'Care Guide',
    content: 'Wipe gently with a clean, damp cloth. Avoid harsh cleaners and direct exposure to sunlight or moisture.',
  },
];

export function ProductInfoAccordionBlock({
  items = DEFAULT_ITEMS,
  textColor = '#171717',
  borderColor = '#e5e5e5',
  mode = 'live',
  store,
}: ProductInfoAccordionBlockProps) {
  const [openItem, setOpenItem] = useState<string | null>(null);

  // Use product info from store if available
  const productInfo = store?.selectedProduct?.info;
  const displayItems = productInfo && productInfo.length > 0 ? productInfo : items;

  const toggleItem = (id: string) => {
    setOpenItem(prev => prev === id ? null : id);
  };

  return (
    <div className="w-full border-t" style={{ borderColor }}>
      {displayItems.map((item: AccordionItem) => (
        <div key={item.id} className="border-b" style={{ borderColor }}>
          <button
            onClick={() => toggleItem(item.id)}
            className="w-full py-4 flex items-center justify-between text-left"
          >
            <span className="text-base font-normal" style={{ color: textColor }}>
              {item.title}
            </span>
            <ChevronRight
              className={`w-4 h-4 transition-transform duration-200 ${
                openItem === item.id ? 'rotate-90' : ''
              }`}
              style={{ color: textColor, opacity: 0.5 }}
            />
          </button>
          {openItem === item.id && (
            <div className="pb-4">
              <p className="text-base leading-relaxed" style={{ color: textColor, opacity: 0.6 }}>
                {item.content}
              </p>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
