"use client";

import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

export interface ProductImageGalleryElementProps {
  images?: string[];
  productName?: string;
  activeImage: number;
  onImageChange: (index: number) => void;
  mode?: 'live' | 'edit' | 'preview';
}

export function ProductImageGalleryElement({
  images = [
    'https://images.unsplash.com/photo-1620916566398-39f1143ab7be?w=800&h=800&fit=crop',
    'https://images.unsplash.com/photo-1556228720-195a672e8a03?w=800&h=800&fit=crop',
    'https://images.unsplash.com/photo-1556228577-2f1a7a2e7c8d?w=800&h=800&fit=crop',
    'https://images.unsplash.com/photo-1556228578-0d85b1a4d571?w=800&h=800&fit=crop',
  ],
  productName = 'Product',
  activeImage,
  onImageChange,
  mode = 'live',
}: ProductImageGalleryElementProps) {
  return (
    <div style={{
      flex: '1 1 auto',
      width: '100%'
    }} className="md:max-w-[60%]">
      {/* Main Image */}
      <div style={{
        position: 'relative',
        marginBottom: '1rem',
        borderRadius: '0.75rem',
        overflow: 'hidden',
        backgroundColor: '#f3f4f6',
        aspectRatio: '1 / 1'
      }}>
        <img
          src={images[activeImage]}
          alt={productName}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover'
          }}
        />
      </div>

      {/* Thumbnail Gallery */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <div style={{
          display: 'flex',
          gap: '0.5rem',
          flex: '1 1 auto',
          overflowX: 'auto'
        }}>
          {images.map((image: string, index: number) => (
            <button
              key={index}
              onClick={() => onImageChange(index)}
              style={{
                position: 'relative',
                width: '5rem',
                height: '5rem',
                borderRadius: '0.5rem',
                overflow: 'hidden',
                border: activeImage === index ? '2px solid currentColor' : '2px solid #e5e7eb',
                transition: 'all 0.2s',
                flexShrink: 0,
                cursor: 'pointer',
                padding: 0,
                background: 'none'
              }}
            >
              <img
                src={image}
                alt={`${productName} ${index + 1}`}
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover'
                }}
              />
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            onClick={() => onImageChange(Math.max(0, activeImage - 1))}
            disabled={activeImage === 0}
            style={{
              borderRadius: '9999px',
              height: '2.5rem',
              width: '2.5rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: '1px solid #e5e7eb',
              backgroundColor: 'white',
              cursor: activeImage === 0 ? 'not-allowed' : 'pointer',
              opacity: activeImage === 0 ? 0.5 : 1
            }}
          >
            <ChevronLeft style={{ height: '1.25rem', width: '1.25rem' }} />
          </button>
          <button
            onClick={() => onImageChange(Math.min(images.length - 1, activeImage + 1))}
            disabled={activeImage === images.length - 1}
            style={{
              borderRadius: '9999px',
              height: '2.5rem',
              width: '2.5rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: '1px solid #e5e7eb',
              backgroundColor: 'white',
              cursor: activeImage === images.length - 1 ? 'not-allowed' : 'pointer',
              opacity: activeImage === images.length - 1 ? 0.5 : 1
            }}
          >
            <ChevronRight style={{ height: '1.25rem', width: '1.25rem' }} />
          </button>
        </div>
      </div>
    </div>
  );
}
