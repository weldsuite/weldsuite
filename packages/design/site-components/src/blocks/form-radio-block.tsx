"use client";

import React from 'react';

export interface FormRadioBlockProps {
  label?: string;
  options?: Array<{ value: string; label: string }>;
  name?: string;
  defaultValue?: string;
  required?: boolean;
  labelColor?: string;
  radioColor?: string;
  mode?: 'live' | 'preview';
}

export function FormRadioBlock({
  label = 'Choose an option',
  options = [
    { value: 'option1', label: 'Option 1' },
    { value: 'option2', label: 'Option 2' },
    { value: 'option3', label: 'Option 3' },
  ],
  name = 'radio-group',
  defaultValue,
  required = false,
  labelColor = '#374151',
  radioColor = '#3b82f6',
  mode = 'live'
}: FormRadioBlockProps) {
  const [selectedValue, setSelectedValue] = React.useState(defaultValue || '');

  return (
    <div className="w-full">
      <label className="block text-sm font-medium mb-3" style={{ color: labelColor }}>
        {label}
        {required && <span className="text-red-500 ml-1">*</span>}
      </label>
      <div className="space-y-3">
        {options.map((option) => (
          <div key={option.value} className="flex items-center gap-3">
            <input
              type="radio"
              id={`${name}-${option.value}`}
              name={name}
              value={option.value}
              checked={selectedValue === option.value}
              onChange={(e) => setSelectedValue(e.target.value)}
              required={required && !selectedValue}
              className="w-4 h-4 border-gray-300 focus:ring-2 focus:ring-offset-0 transition-all cursor-pointer"
              style={{
                accentColor: radioColor,
              }}
            />
            <label
              htmlFor={`${name}-${option.value}`}
              className="text-sm font-medium cursor-pointer select-none"
              style={{ color: labelColor }}
            >
              {option.label}
            </label>
          </div>
        ))}
      </div>
    </div>
  );
}
