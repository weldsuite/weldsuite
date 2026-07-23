"use client";

import React from 'react';

export interface FormInputBlockProps {
  label?: string;
  placeholder?: string;
  type?: 'text' | 'email' | 'tel' | 'url';
  required?: boolean;
  validationMessage?: string;
  name?: string;
  value?: string;
  labelColor?: string;
  inputBorderColor?: string;
  inputBackgroundColor?: string;
  mode?: 'live' | 'preview';
}

export function FormInputBlock({
  label = 'Input Label',
  placeholder = 'Enter text...',
  type = 'text',
  required = false,
  validationMessage = 'This field is required',
  name,
  value,
  labelColor = '#374151',
  inputBorderColor = '#d1d5db',
  inputBackgroundColor = '#ffffff',
  mode = 'live'
}: FormInputBlockProps) {
  const [inputValue, setInputValue] = React.useState(value || '');
  const [showError, setShowError] = React.useState(false);

  const handleBlur = () => {
    if (required && !inputValue.trim()) {
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
      <input
        type={type}
        name={name || label.toLowerCase().replace(/\s+/g, '-')}
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onBlur={handleBlur}
        placeholder={placeholder}
        required={required}
        className="w-full px-4 py-2 rounded-lg border focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"
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
