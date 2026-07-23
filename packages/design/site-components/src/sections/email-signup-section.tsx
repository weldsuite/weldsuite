"use client";

import React, { useState } from 'react';
import { Mail } from 'lucide-react';
import { cn } from '@weldsuite/ui/lib/utils';

interface EmailSignupSectionProps {
  heading?: string;
  text?: string;
  buttonText?: string;
  backgroundColor?: string;
  textColor?: string;
  showImage?: boolean;
  image?: string;
  paddingTop?: number;
  paddingBottom?: number;
  sectionId?: string;
}

export function EmailSignupSection({
  heading = 'Stay in the loop',
  text = 'Subscribe to our newsletter for exclusive offers and updates',
  buttonText = 'Subscribe',
  backgroundColor = '#f9fafb',
  textColor = '#000000',
  showImage = false,
  image = 'https://images.unsplash.com/photo-1557821552-17105176677c?w=600&h=400&fit=crop',
  paddingTop = 80,
  paddingBottom = 80,
  sectionId,
}: EmailSignupSectionProps) {
  const [email, setEmail] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Handle email submission
    console.log('Email submitted:', email);
    setEmail('');
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
      <div className="max-w-2xl mx-auto">
        <div className="text-center">
          {/* Content */}
          <div className="mb-4">
            <h2
              className="text-4xl font-bold tracking-tight"
              style={{
                color: textColor
              }}
            >
              {heading}
            </h2>
          </div>
          <p
            className="text-lg mb-8"
            style={{
              color: textColor,
              opacity: 0.8
            }}
          >
            {text}
          </p>

          {/* Email Form */}
          <form onSubmit={handleSubmit} className="flex gap-2 max-w-md mx-auto">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Enter your email"
              required
              className="flex-1 px-4 py-3 border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-gray-400 focus:border-gray-400 bg-white"
            />
            <button
              type="submit"
              className="px-6 py-3 bg-black text-white font-medium rounded-md hover:bg-gray-800 transition-all whitespace-nowrap"
            >
              {buttonText}
            </button>
          </form>
        </div>
      </div>
    </section>
  );
}
