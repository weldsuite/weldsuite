"use client";

import React, { useState } from 'react';

export interface GalleryBlockProps {
  images?: Array<{ src: string; alt: string; caption?: string }>;
  columns?: 2 | 3 | 4 | 5 | 6;
  gap?: 'sm' | 'md' | 'lg';
  lightbox?: boolean;
  mode?: 'live' | 'preview';
}

export function GalleryBlock({
  images = [
    { src: 'https://via.placeholder.com/400x300', alt: 'Gallery image 1' },
    { src: 'https://via.placeholder.com/400x300', alt: 'Gallery image 2' },
    { src: 'https://via.placeholder.com/400x300', alt: 'Gallery image 3' },
  ],
  columns = 3,
  gap = 'md',
  lightbox = true,
  mode = 'live'
}: GalleryBlockProps) {
  const [selectedImage, setSelectedImage] = useState<number | null>(null);

  const columnClasses = {
    2: 'grid-cols-1 sm:grid-cols-2',
    3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
    4: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4',
    5: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-5',
    6: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-6',
  }[columns];

  const gapClasses = {
    sm: 'gap-2',
    md: 'gap-4',
    lg: 'gap-6',
  }[gap];

  const handleImageClick = (index: number) => {
    if (lightbox) {
      setSelectedImage(index);
    }
  };

  const closeLightbox = () => {
    setSelectedImage(null);
  };

  const navigateLightbox = (direction: 'prev' | 'next') => {
    if (selectedImage === null) return;

    if (direction === 'prev') {
      setSelectedImage(selectedImage > 0 ? selectedImage - 1 : images.length - 1);
    } else {
      setSelectedImage(selectedImage < images.length - 1 ? selectedImage + 1 : 0);
    }
  };

  return (
    <>
      <div className={`grid ${columnClasses} ${gapClasses}`}>
        {images.map((image, index) => (
          <div
            key={index}
            className={`relative overflow-hidden rounded-lg ${lightbox ? 'cursor-pointer' : ''}`}
            onClick={() => handleImageClick(index)}
          >
            <img
              src={image.src}
              alt={image.alt}
              className="w-full h-full object-cover transition-transform hover:scale-105"
            />
            {image.caption && (
              <div className="absolute bottom-0 left-0 right-0 bg-black bg-opacity-60 text-white p-2 text-sm">
                {image.caption}
              </div>
            )}
          </div>
        ))}
      </div>

      {lightbox && selectedImage !== null && (
        <div
          className="fixed inset-0 z-50 bg-black bg-opacity-90 flex items-center justify-center"
          onClick={closeLightbox}
        >
          <button
            className="absolute top-4 right-4 text-white text-4xl hover:opacity-80"
            onClick={closeLightbox}
          >
            &times;
          </button>
          <button
            className="absolute left-4 text-white text-4xl hover:opacity-80"
            onClick={(e) => {
              e.stopPropagation();
              navigateLightbox('prev');
            }}
          >
            &#8249;
          </button>
          <button
            className="absolute right-4 text-white text-4xl hover:opacity-80"
            onClick={(e) => {
              e.stopPropagation();
              navigateLightbox('next');
            }}
          >
            &#8250;
          </button>
          <div className="max-w-5xl max-h-[90vh] px-12" onClick={(e) => e.stopPropagation()}>
            <img
              src={images[selectedImage]?.src || ''}
              alt={images[selectedImage]?.alt || ''}
              className="max-w-full max-h-[90vh] object-contain"
            />
            {images[selectedImage]?.caption && (
              <p className="text-white text-center mt-4">{images[selectedImage].caption}</p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
