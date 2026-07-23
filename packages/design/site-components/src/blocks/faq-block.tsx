"use client";

import React from 'react';
import { FAQSection } from '../sections/faq-section';

interface FAQItem {
  id: string;
  question: string;
  answer: string;
}

export interface FAQBlockProps {
  heading?: string;
  subheading?: string;
  faqs?: FAQItem[];
  backgroundColor?: string;
  textColor?: string;
  paddingTop?: number;
  paddingBottom?: number;
  mode?: 'live' | 'edit' | 'preview';
}

export function FAQBlock({
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
}: FAQBlockProps) {
  return (
    <FAQSection
      heading={heading}
      subheading={subheading}
      faqs={faqs}
      backgroundColor={backgroundColor}
      textColor={textColor}
      paddingTop={paddingTop}
      paddingBottom={paddingBottom}
      mode={mode === 'edit' || mode === 'preview' ? 'builder' : 'live'}
    />
  );
}
