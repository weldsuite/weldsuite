"use client";

import React from 'react';
import { ArrowRight } from 'lucide-react';

export interface EmailFormBlockProps {
  placeholder?: string;
  onSubmit?: (email: string) => void;
  mode?: 'live' | 'preview';
}

export function EmailFormBlock({
  placeholder = 'Email',
  onSubmit,
  mode = 'live'
}: EmailFormBlockProps) {
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
    <div className="w-full">
      {isSubmitted ? (
        <div className="bg-green-50 text-green-800 py-3 px-4 rounded-md text-sm text-center">
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
              <ArrowRight className="w-4 h-4 text-gray-900" />
            </button>
          </div>
          {error && (
            <p className="text-red-500 text-xs mt-2 text-left">{error}</p>
          )}
        </form>
      )}
    </div>
  );
}
