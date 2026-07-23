"use client";

import React from 'react';

interface FormField {
  id: string;
  type: 'text' | 'email' | 'select' | 'textarea' | 'tel' | 'number';
  label: string;
  placeholder?: string;
  required?: boolean;
  width?: 'half' | 'full';
  options?: string[]; // For select fields
}

interface ContactFormModernSectionProps {
  backgroundColor?: string;
  textColor?: string;
  paddingTop?: number;
  paddingBottom?: number;
  headingText?: string;
  buttonText?: string;
  buttonBackgroundColor?: string;
  buttonTextColor?: string;
  inputBackgroundColor?: string;
  inputBorderColor?: string;
  maxWidth?: number;
  customFields?: FormField[];
}

export function ContactFormModernSection({
  backgroundColor = '#ffffff',
  textColor = '#000000',
  paddingTop = 64,
  paddingBottom = 64,
  headingText = 'Love to hear from you,\nGet in touch 👋',
  buttonText = 'Send',
  buttonBackgroundColor = '#000000',
  buttonTextColor = '#ffffff',
  inputBackgroundColor = '#f9fafb',
  inputBorderColor = '#e5e7eb',
  maxWidth = 800,
  customFields = [],
}: ContactFormModernSectionProps) {
  // Helper function to render a form field
  const renderField = (field: FormField) => {
    const fieldStyle = {
      height: field.type === 'textarea' ? 'auto' : '3rem',
      minHeight: field.type === 'textarea' ? '140px' : undefined,
      width: '100%',
      borderRadius: '0.5rem',
      border: `1px solid ${inputBorderColor}`,
      backgroundColor: inputBackgroundColor,
      padding: field.type === 'textarea' ? '0.75rem 1rem' : '0 1rem',
      fontSize: '0.875rem',
      outline: 'none',
      appearance: field.type === 'select' ? ('none' as const) : undefined,
      backgroundImage: field.type === 'select' ? 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' fill=\'none\' viewBox=\'0 0 24 24\' stroke=\'%236b7280\'%3E%3Cpath stroke-linecap=\'round\' stroke-linejoin=\'round\' stroke-width=\'2\' d=\'M19 9l-7 7-7-7\'/%3E%3C/svg%3E")' : undefined,
      backgroundRepeat: field.type === 'select' ? ('no-repeat' as const) : undefined,
      backgroundPosition: field.type === 'select' ? 'right 0.75rem center' : undefined,
      backgroundSize: field.type === 'select' ? '1.25rem' : undefined,
      paddingRight: field.type === 'select' ? '2.5rem' : '1rem',
      resize: field.type === 'textarea' ? ('none' as const) : undefined,
    };

    return (
      <div key={field.id} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <label
          htmlFor={field.id}
          style={{
            fontSize: '0.875rem',
            fontWeight: 500,
            color: textColor,
          }}
        >
          {field.label}{field.required && <span style={{ color: '#ef4444' }}> *</span>}
        </label>
        {field.type === 'select' ? (
          <select
            id={field.id}
            name={field.id}
            required={field.required}
            style={fieldStyle}
          >
            {field.options?.map((option, idx) => (
              <option key={idx} value={option}>{option}</option>
            ))}
          </select>
        ) : field.type === 'textarea' ? (
          <textarea
            id={field.id}
            name={field.id}
            required={field.required}
            rows={5}
            style={fieldStyle}
            placeholder={field.placeholder || ''}
          />
        ) : (
          <input
            type={field.type}
            id={field.id}
            name={field.id}
            required={field.required}
            style={fieldStyle}
            placeholder={field.placeholder || ''}
          />
        )}
      </div>
    );
  };
  return (
    <div
      style={{
        width: '100%',
        backgroundColor: backgroundColor,
        paddingTop: `${paddingTop}px`,
        paddingBottom: `${paddingBottom}px`,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <div style={{ width: '100%', maxWidth: `${maxWidth}px`, padding: '0 2rem' }}>
        <div>
          {/* Header */}
          <div
            style={{
              textAlign: 'left',
              marginBottom: '3rem',
            }}
          >
            <h2
              style={{
                fontSize: '2.5rem',
                fontWeight: 600,
                letterSpacing: '-0.02em',
                color: textColor,
                lineHeight: '1.2',
                whiteSpace: 'pre-line',
              }}
            >
              {headingText}
            </h2>
          </div>

          {/* Form */}
          <form style={{ width: '100%' }}>
            {/* All Fields */}
            {customFields && customFields.length > 0 && (
              <>
                {(() => {
                  const rows: FormField[][] = [];
                  let currentRow: FormField[] = [];

                  customFields.forEach((field) => {
                    if (field.width === 'full') {
                      if (currentRow.length > 0) {
                        rows.push(currentRow);
                        currentRow = [];
                      }
                      rows.push([field]);
                    } else {
                      currentRow.push(field);
                      if (currentRow.length === 2) {
                        rows.push(currentRow);
                        currentRow = [];
                      }
                    }
                  });

                  if (currentRow.length > 0) {
                    rows.push(currentRow);
                  }

                  return rows.map((row, rowIdx) => (
                    <div
                      key={rowIdx}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: row.length === 1 ? '1fr' : '1fr 1fr',
                        gap: '1.5rem',
                        marginBottom: rowIdx === rows.length - 1 ? '2rem' : '1.5rem'
                      }}
                    >
                      {row.map((field) => renderField(field))}
                    </div>
                  ));
                })()}
              </>
            )}

            {/* Send button - full width dark */}
            <button
              type="submit"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.5rem',
                borderRadius: '0.5rem',
                fontSize: '0.9375rem',
                fontWeight: 500,
                height: '3rem',
                width: '100%',
                backgroundColor: buttonBackgroundColor,
                color: buttonTextColor,
                border: 'none',
                cursor: 'pointer',
                transition: 'background-color 0.2s',
              }}
              onMouseOver={(e) => {
                const rgb = parseInt(buttonBackgroundColor.replace('#', ''), 16);
                const r = (rgb >> 16) & 0xff;
                const g = (rgb >> 8) & 0xff;
                const b = rgb & 0xff;
                const factor = 0.9;
                const newR = Math.floor(r * factor);
                const newG = Math.floor(g * factor);
                const newB = Math.floor(b * factor);
                e.currentTarget.style.backgroundColor = `rgb(${newR}, ${newG}, ${newB})`;
              }}
              onMouseOut={(e) => {
                e.currentTarget.style.backgroundColor = buttonBackgroundColor;
              }}
            >
              {buttonText}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
