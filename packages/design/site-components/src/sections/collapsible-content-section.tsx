"use client";

import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@weldsuite/ui/lib/utils';

interface CollapsibleItem {
  question: string;
  answer: string;
}

interface CollapsibleContentSectionProps {
  heading?: string;
  items?: CollapsibleItem[];
  backgroundColor?: string;
  textColor?: string;
  paddingTop?: number;
  paddingBottom?: number;
  sectionId?: string;
}

export function CollapsibleContentSection({
  heading = 'Frequently Asked Questions',
  items = [
    { question: 'What is your shipping policy?', answer: 'We offer free shipping on all orders over $50. Standard shipping typically takes 3-5 business days, while express shipping delivers within 1-2 business days.' },
    { question: 'What is your return policy?', answer: 'Returns are accepted within 30 days of purchase. Items must be unused and in original packaging. We provide a full refund once we receive and inspect the returned item.' },
    { question: 'How can I track my order?', answer: 'You will receive a tracking number via email once your order ships. You can use this number to track your package on our website or the carrier\'s tracking portal.' },
    { question: 'Do you ship internationally?', answer: 'Yes, we ship to most countries worldwide. International shipping costs and delivery times vary by location. Customs fees may apply depending on your country.' },
    { question: 'What payment methods do you accept?', answer: 'We accept all major credit cards (Visa, MasterCard, American Express), PayPal, Apple Pay, and Google Pay. All payments are processed securely through encrypted connections.' }
  ],
  backgroundColor = '#ffffff',
  textColor = '#000000',
  paddingTop = 60,
  paddingBottom = 60,
  sectionId,
}: CollapsibleContentSectionProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const toggleItem = (index: number) => {
    setOpenIndex(openIndex === index ? null : index);
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
      <div className="max-w-3xl mx-auto">
        {heading && (
          <h2
            className="text-4xl font-bold tracking-tight mb-12"
            style={{
              color: textColor
            }}
          >
            {heading}
          </h2>
        )}

        <div className="space-y-4">
          {items.map((item, index) => {
            return (
              <div
                key={index}
                className="border border-gray-200 rounded-lg overflow-hidden"
              >
                <button
                  onClick={() => toggleItem(index)}
                  className="w-full flex items-center justify-between p-4 text-left hover:bg-gray-50 transition-colors"
                >
                  <span
                    className="text-base font-medium"
                    style={{
                      color: textColor
                    }}
                  >
                    {item.question}
                  </span>
                  <ChevronDown
                    className={`w-5 h-5 transition-transform flex-shrink-0 ml-4 ${
                      openIndex === index ? 'rotate-180' : ''
                    }`}
                    style={{ color: textColor }}
                  />
                </button>

                <div
                  className={`overflow-hidden transition-all duration-200 ease-in-out ${
                    openIndex === index ? 'max-h-96 opacity-100' : 'max-h-0 opacity-0'
                  }`}
                >
                  <div
                    className="px-4 pb-4 pt-2 text-sm"
                    style={{
                      color: textColor,
                      opacity: 0.8
                    }}
                  >
                    {item.answer}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
