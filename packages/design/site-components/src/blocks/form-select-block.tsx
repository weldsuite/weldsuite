"use client";

import React from 'react';

export interface FormSelectBlockProps {
  label?: string;
  options?: Array<{ value: string; label: string }>;
  required?: boolean;
  validationMessage?: string;
  name?: string;
  defaultValue?: string;
  labelColor?: string;
  inputBorderColor?: string;
  inputBackgroundColor?: string;
  mode?: 'live' | 'preview';
}

export function FormSelectBlock({
  label = 'Select Option',
  options = [
    { value: 'option1', label: 'Option 1' },
    { value: 'option2', label: 'Option 2' },
    { value: 'option3', label: 'Option 3' },
  ],
  required = false,
  validationMessage = 'Please select an option',
  name,
  defaultValue,
  labelColor = '#374151',
  inputBorderColor = '#d1d5db',
  inputBackgroundColor = '#ffffff',
  mode = 'live'
}: FormSelectBlockProps) {
  const [selectedValue, setSelectedValue] = React.useState(defaultValue || '');
  const [showError, setShowError] = React.useState(false);

  const handleBlur = () => {
    if (required && !selectedValue) {
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
      <select
        name={name || label.toLowerCase().replace(/\s+/g, '-')}
        value={selectedValue}
        onChange={(e) => setSelectedValue(e.target.value)}
        onBlur={handleBlur}
        required={required}
        className="w-full px-4 py-2 rounded-lg border focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all appearance-none bg-no-repeat bg-right"
        style={{
          borderColor: showError ? '#ef4444' : inputBorderColor,
          backgroundColor: inputBackgroundColor,
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%23374151'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'%3E%3C/path%3E%3C/svg%3E")`,
          backgroundSize: '1.5rem',
          backgroundPosition: 'right 0.5rem center',
          paddingRight: '2.5rem',
        }}
      >
        <option value="">Select...</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {showError && required && (
        <p className="text-red-500 text-sm mt-1">{validationMessage}</p>
      )}
    </div>
  );
}
