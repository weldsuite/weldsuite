"use client";

import React from 'react';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@weldsuite/ui/components/accordion';

interface FAQItem {
  id: string;
  question: string;
  answer: string;
}

interface FAQSectionProps {
  heading?: string;
  subheading?: string;
  faqs?: FAQItem[];
  backgroundColor?: string;
  textColor?: string;
  paddingTop?: number;
  paddingBottom?: number;
  mode?: 'live' | 'builder';
}

export function FAQSection({
  heading = 'Frequently Asked Questions',
  subheading = 'Find answers to common questions about our products and services',
  faqs = [
    {
      id: '1',
      question: 'What is your return policy?',
      answer: 'We offer a 30-day return policy on all unused items in their original packaging. Simply contact our support team to initiate a return.',
    },
    {
      id: '2',
      question: 'How long does shipping take?',
      answer: 'Standard shipping typically takes 5-7 business days. Express shipping options are available at checkout for faster delivery.',
    },
    {
      id: '3',
      question: 'Do you ship internationally?',
      answer: 'Yes, we ship to most countries worldwide. International shipping costs and delivery times vary by location.',
    },
    {
      id: '4',
      question: 'How can I track my order?',
      answer: 'Once your order ships, you will receive a tracking number via email. You can use this number to track your package on our website or the carrier\'s website.',
    },
  ],
  backgroundColor = '#ffffff',
  textColor = '#000000',
  paddingTop = 64,
  paddingBottom = 64,
  mode = 'live',
}: FAQSectionProps) {
  return (
    <div
      style={{
        width: '100%',
        backgroundColor,
        paddingTop: `${paddingTop}px`,
        paddingBottom: `${paddingBottom}px`,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        flexDirection: 'column',
      }}
    >
      <div style={{ width: '100%', maxWidth: '1400px', padding: '0 2rem' }}>
        {/* Header */}
        <div
          style={{
            textAlign: 'center',
            marginBottom: '3rem',
          }}
        >
          <h2
            style={{
              fontSize: '2.25rem',
              fontWeight: 700,
              letterSpacing: '-0.025em',
              marginBottom: '0.75rem',
              color: textColor,
            }}
          >
            {heading}
          </h2>
          {subheading && (
            <p
              style={{
                fontSize: '1.125rem',
                color: textColor,
                opacity: 0.7,
              }}
            >
              {subheading}
            </p>
          )}
        </div>

        {/* FAQ Accordion */}
        <div style={{ width: '800px', maxWidth: '100%', margin: '0 auto' }}>
          <Accordion type="single" collapsible style={{ width: '800px', maxWidth: '100%' }}>
            {faqs.map((faq) => (
              <AccordionItem key={faq.id} value={faq.id} style={{ width: '800px', maxWidth: '100%' }}>
                <AccordionTrigger
                  className="text-left text-lg font-medium hover:no-underline"
                  style={{ color: textColor, width: '800px', maxWidth: '100%', boxSizing: 'border-box' }}
                >
                  <span style={{ flex: 1, wordBreak: 'break-word', overflow: 'hidden' }}>
                    {faq.question}
                  </span>
                </AccordionTrigger>
                <AccordionContent
                  className="text-base"
                  style={{ color: textColor, opacity: 0.8, width: '800px', maxWidth: '100%', boxSizing: 'border-box', overflow: 'hidden' }}
                >
                  <div style={{ width: '100%', wordBreak: 'break-word', overflow: 'hidden' }}>
                    {faq.answer}
                  </div>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </div>
    </div>
  );
}
