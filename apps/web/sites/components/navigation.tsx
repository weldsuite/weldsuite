"use client";

import { useState } from 'react';
import Link from 'next/link';

interface NavigationProps {
  navigation: any[];
  logo?: string;
  siteName: string;
}

export default function Navigation({ navigation, logo, siteName }: NavigationProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  if (!navigation || navigation.length === 0) {
    return null;
  }

  return (
    <nav className="bg-white shadow-sm border-b">
      <div className="container mx-auto px-4">
        <div className="flex justify-between items-center h-16">
          {/* Logo/Site Name */}
          <div className="flex items-center">
            {logo ? (
              <img src={logo} alt={siteName} className="h-8 w-auto" />
            ) : (
              <span className="text-xl font-bold">{siteName}</span>
            )}
          </div>

          {/* Desktop Navigation */}
          <div className="hidden md:flex space-x-8">
            {navigation.map((item: any, index: number) => (
              <Link
                key={item.id || index}
                href={item.href || '#'}
                className="text-gray-700 hover:text-primary transition-colors"
              >
                {item.label || item.title}
              </Link>
            ))}
          </div>

          {/* Mobile Menu Button */}
          <div className="md:hidden">
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="text-gray-700 hover:text-gray-900"
              aria-label="Toggle menu"
            >
              <svg
                className="h-6 w-6"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                {mobileMenuOpen ? (
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                ) : (
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 6h16M4 12h16M4 18h16"
                  />
                )}
              </svg>
            </button>
          </div>
        </div>

        {/* Mobile Navigation */}
        {mobileMenuOpen && (
          <div className="md:hidden py-4 border-t">
            <div className="flex flex-col space-y-2">
              {navigation.map((item: any, index: number) => (
                <Link
                  key={item.id || index}
                  href={item.href || '#'}
                  className="px-3 py-2 text-gray-700 hover:text-primary hover:bg-gray-50 rounded transition-colors"
                  onClick={() => setMobileMenuOpen(false)}
                >
                  {item.label || item.title}
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </nav>
  );
}