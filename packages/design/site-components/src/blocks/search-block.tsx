import React from 'react';

export interface SearchBlockProps {
  placeholder?: string;
  buttonText?: string;
  variant?: 'default' | 'minimal' | 'icon-only';
  mode?: 'live' | 'preview';
}

export function SearchBlock({
  placeholder = 'Search...',
  buttonText = 'Search',
  variant = 'default',
  mode = 'live'
}: SearchBlockProps) {
  const [query, setQuery] = React.useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === 'live' && query) {
      window.location.href = `/search?q=${encodeURIComponent(query)}`;
    }
  };

  if (variant === 'icon-only') {
    return (
      <form onSubmit={handleSubmit} className="relative">
        <button
          type="button"
          className="p-2 text-gray-700 hover:text-gray-900 transition-colors"
          onClick={() => {
            // Toggle search modal in live mode
          }}
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </button>
      </form>
    );
  }

  if (variant === 'minimal') {
    return (
      <form onSubmit={handleSubmit} className="relative max-w-md">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          className="w-full px-4 py-2 pr-10 border-b border-gray-300 focus:outline-none focus:border-gray-900 transition-colors bg-transparent"
        />
        <button
          type="submit"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-900 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2 max-w-md">
      <div className="relative flex-1">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          className="w-full px-4 py-2 pl-10 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent"
        />
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
      </div>
      <button
        type="submit"
        className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-800 transition-colors font-medium"
      >
        {buttonText}
      </button>
    </form>
  );
}
