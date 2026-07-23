"use client";

import React from 'react';

export interface FormTextareaBlockProps {
  label?: string;
  placeholder?: string;
  rows?: number;
  required?: boolean;
  validationMessage?: string;
  name?: string;
  value?: string;
  labelColor?: string;
  inputBorderColor?: string;
  inputBackgroundColor?: string;
  mode?: 'live' | 'preview';
}

export function FormTextareaBlock({
  label = 'Message',
  placeholder = 'Enter your message...',
  rows = 4,
  required = false,
  validationMessage = 'This field is required',
  name,
  value,
  labelColor = '#374151',
  inputBorderColor = '#d1d5db',
  inputBackgroundColor = '#ffffff',
  mode = 'live'
}: FormTextareaBlockProps) {
  const [textValue, setTextValue] = React.useState(value || '');
  const [showError, setShowError] = React.useState(false);

  const handleBlur = () => {
    if (required && !textValue.trim()) {
      setShowError(true);
    } else {
      setShowError(false);
    }
  };

  return (
    <div className="w-full">
      <label className="block text-sm font-medium mb-2" style={{ color: labelColor }}>
        {label}
        {required && <span className="text-red-500 ml-1">*</span>}
      </label>
      <textarea
        name={name || label.toLowerCase().replace(/\s+/g, '-')}
        value={textValue}
        onChange={(e) => setTextValue(e.target.value)}
        onBlur={handleBlur}
        placeholder={placeholder}
        required={required}
        rows={rows}
        className="w-full px-4 py-2 rounded-lg border focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all resize-y"
        style={{
          borderColor: showError ? '#ef4444' : inputBorderColor,
          backgroundColor: inputBackgroundColor,
        }}
      />
      {showError && required && (
        <p className="text-red-500 text-sm mt-1">{validationMessage}</p>
      )}
    </div>
  );
}
