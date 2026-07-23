"use client";

import React from 'react';
import { ArrowRight } from 'lucide-react';

export interface NewsletterBlockProps {
  heading?: string;
  description?: string;
  placeholder?: string;
  backgroundColor?: string;
  textColor?: string;
  onSubmit?: (email: string) => void;
  mode?: 'live' | 'preview';
}

export function NewsletterBlock({
  heading = 'Subscribe to our emails',
  description = 'Be the first to know about new collections and exclusive offers.',
  placeholder = 'Email',
  backgroundColor = '#ffffff',
  textColor = '#000000',
  onSubmit,
  mode = 'live'
}: NewsletterBlockProps) {
  const [email, setEmail] = React.useState('');
  const [isSubmitted, setIsSubmitted] = React.useState(false);
  const [error, setError] = React.useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!email || !email.includes('@')) {
      setError('Please enter a valid email address');
      return;
    }

    if (onSubmit) {
      onSubmit(email);
    }

    setIsSubmitted(true);
    setEmail('');

    setTimeout(() => setIsSubmitted(false), 3000);
  };

  return (
    <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      <div className="max-w-xl mx-auto text-center">
        <h2
          className="text-2xl md:text-3xl font-bold mb-3"
          style={{ color: textColor }}
        >
          {heading}
        </h2>

        <p
          className="text-sm md:text-base mb-8"
          style={{ color: textColor, opacity: 0.7 }}
        >
          {description}
        </p>

        {isSubmitted ? (
          <div className="bg-green-50 text-green-800 py-3 px-4 rounded-md text-sm">
            Thank you for subscribing!
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="max-w-md mx-auto">
            <div className="relative">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={placeholder}
                className="w-full px-4 py-3 pr-12 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-gray-900 focus:border-gray-900"
                required
              />
              <button
                type="submit"
                className="absolute right-2 top-1/2 -translate-y-1/2 p-2 hover:bg-gray-100 rounded-md transition-colors"
              >
                <ArrowRight className="w-4 h-4" style={{ color: textColor }} />
              </button>
            </div>
            {error && (
              <p className="text-red-500 text-xs mt-2 text-left">{error}</p>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
