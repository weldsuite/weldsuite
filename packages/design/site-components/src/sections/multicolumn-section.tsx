"use client";

import React from 'react';
import { Package, RotateCcw, Shield } from 'lucide-react';
import { cn } from '@weldsuite/ui/lib/utils';

interface MulticolumnItem {
  heading: string;
  text: string;
  icon?: string;
}

interface MulticolumnSectionProps {
  heading?: string;
  columns?: MulticolumnItem[];
  buttonText?: string;
  buttonLink?: string;
  backgroundColor?: string;
  paddingTop?: number;
  paddingBottom?: number;
  columnCount?: 2 | 3 | 4;
  sectionId?: string;
}

export function MulticolumnSection({
  heading = 'Why Choose Us',
  columns = [
    {
      heading: 'Free Shipping',
      text: 'Enjoy free shipping on all orders over $50. We deliver to your doorstep quickly and reliably. Track your package every step of the way. No hidden fees or surprises at checkout.',
      icon: 'package'
    },
    {
      heading: 'Easy Returns',
      text: 'Not satisfied? No problem. We offer a hassle-free 30-day return policy. Simply contact our support team and we will process your return. Full refund guaranteed for eligible returns.',
      icon: 'rotate-ccw'
    },
    {
      heading: 'Secure Payment',
      text: 'Your payment information is protected with industry-leading encryption. We accept all major credit cards and digital payment methods. Shop with confidence knowing your data is safe. PCI compliant checkout process.',
      icon: 'shield'
    }
  ],
  buttonText = 'Learn More',
  buttonLink = '/about',
  backgroundColor = '#ffffff',
  paddingTop = 60,
  paddingBottom = 60,
  columnCount = 3,
  sectionId,
}: MulticolumnSectionProps) {
  const gridCols = {
    2: 'md:grid-cols-2',
    3: 'md:grid-cols-3',
    4: 'md:grid-cols-4',
  };

  const iconMap: Record<string, React.ComponentType<any>> = {
    'package': Package,
    'rotate-ccw': RotateCcw,
    'shield': Shield,
  };

  const getIcon = (iconName?: string) => {
    if (!iconName) return Package;
    return iconMap[iconName] || Package;
  };

  return (
    <section
      className="px-4 md:px-8"
      style={{
        backgroundColor,
        paddingTop: `${paddingTop}px`,
        paddingBottom: `${paddingBottom}px`
      }}
    >
      <div className="container mx-auto" style={{ maxWidth: '1400px' }}>
        {/* Section Heading */}
        {heading && (
          <div className="text-center mb-10">
            <h2 className="text-4xl font-bold text-gray-900">
              {heading}
            </h2>
          </div>
        )}

        {/* Columns Grid */}
        <div className={`grid grid-cols-1 ${gridCols[columnCount]} gap-4`}>
          {columns.map((column, index) => {
            const Icon = getIcon(column.icon);

            return (
              <div
                key={index}
                className="p-8 bg-gray-50 rounded-lg min-h-[200px] border border-gray-200"
              >
                <div className="flex items-center gap-2.5 mb-3">
                  <div className="w-7 h-7 bg-gray-200 rounded-md flex items-center justify-center flex-shrink-0">
                    <Icon className="w-4 h-4 text-gray-900" />
                  </div>
                  <h3 className="text-lg font-semibold text-gray-900">
                    {column.heading}
                  </h3>
                </div>
                <p className="text-base text-gray-600 text-left leading-relaxed line-clamp-4">
                  {column.text}
                </p>
              </div>
            );
          })}
        </div>

        {/* Button */}
        {buttonText && (
          <div className="flex justify-center mt-10">
            <a
              href={buttonLink}
              className="inline-block px-8 py-3 bg-black text-white font-medium hover:bg-gray-800 transition-all rounded-md"
            >
              {buttonText}
            </a>
          </div>
        )}
      </div>
    </section>
  );
}
