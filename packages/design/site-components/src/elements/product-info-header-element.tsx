"use client";

import React from 'react';

export interface ProductInfoHeaderElementProps {
  storeName?: string;
  mode?: 'live' | 'edit' | 'preview';
}

export function ProductInfoHeaderElement({
  storeName = 'rhode',
  mode = 'live',
}: ProductInfoHeaderElementProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
      <div style={{
        width: '2.5rem',
        height: '2.5rem',
        backgroundColor: '#f3f4f6',
        borderRadius: '0.75rem',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}>
        <span style={{ fontSize: '0.75rem', fontWeight: 'bold', color: '#9ca3af' }}>
          {storeName[0]?.toUpperCase() || ''}
        </span>
      </div>
      <span style={{ fontWeight: '600', fontSize: '1.125rem' }}>{storeName}</span>
    </div>
  );
}
