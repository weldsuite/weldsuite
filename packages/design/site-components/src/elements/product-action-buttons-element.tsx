"use client";

import { Truck, Store, Undo2 } from 'lucide-react';

export interface ProductActionButtonsElementProps {
  addToCartText?: string;
  buyNowText?: string;
  buttonColor?: string;
  textColor?: string;
  mode?: 'live' | 'edit' | 'preview';
}

export function ProductActionButtonsElement({
  addToCartText = 'Aan winkelwagen toevoegen',
  buyNowText = 'Koop nu',
  buttonColor = '#000000',
  textColor = '#000000',
}: ProductActionButtonsElementProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <button
        style={{
          width: '100%',
          height: '3rem',
          fontSize: '1rem',
          backgroundColor: '#5B4EFF',
          color: 'white',
          borderRadius: '9999px',
          border: 'none',
          cursor: 'pointer',
          fontWeight: '500'
        }}
      >
        {addToCartText}
      </button>
      <button
        style={{
          width: '100%',
          height: '3rem',
          fontSize: '1rem',
          backgroundColor: buttonColor,
          color: 'white',
          borderRadius: '9999px',
          border: 'none',
          cursor: 'pointer',
          fontWeight: '500'
        }}
      >
        {buyNowText}
      </button>

      {/* Shipping & Return Information */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
        paddingTop: '1rem',
        borderTop: `1px solid ${textColor}33`
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Truck style={{ height: '1rem', width: '1rem', color: textColor, opacity: 0.7 }} />
          <span style={{ fontSize: '0.75rem', color: textColor, opacity: 0.7 }}>
            gratis thuisbezorgd vanaf 30-
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Store style={{ height: '1rem', width: '1rem', color: textColor, opacity: 0.7 }} />
          <span style={{ fontSize: '0.75rem', color: textColor, opacity: 0.7 }}>
            gratis afhalen in 500+ winkels vanaf 15-
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Undo2 style={{ height: '1rem', width: '1rem', color: textColor, opacity: 0.7 }} />
          <span style={{ fontSize: '0.75rem', color: textColor, opacity: 0.7 }}>
            gratis retourneren binnen 30 dagen
          </span>
        </div>
      </div>
    </div>
  );
}
