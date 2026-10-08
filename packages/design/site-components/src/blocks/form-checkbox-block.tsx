"use client";

import React from 'react';

export interface FormCheckboxBlockProps {
  label?: string;
  checked?: boolean;
  required?: boolean;
  name?: string;
  labelColor?: string;
  checkboxColor?: string;
  mode?: 'live' | 'preview';
}

export function FormCheckboxBlock({
  label = 'I agree to the terms and conditions',
  checked = false,
  required = false,
  name,
  labelColor = '#374151',
  checkboxColor = '#3b82f6'
}: Readonly<FormCheckboxBlockProps>) {
  const [isChecked, setIsChecked] = React.useState(checked);
  const inputId = React.useId();

  return (
    <div className="flex items-start gap-3">
      <div className="flex items-center h-5">
        <input
          id={inputId}
          type="checkbox"
          name={name || 'checkbox'}
          checked={isChecked}
          onChange={(e) => setIsChecked(e.target.checked)}
          required={required}
          className="w-4 h-4 rounded border-gray-300 focus:ring-2 focus:ring-offset-0 transition-all cursor-pointer"
          style={{
            accentColor: checkboxColor,
          }}
        />
      </div>
      <label
        htmlFor={inputId}
        className="text-sm font-medium cursor-pointer select-none"
        style={{ color: labelColor }}
      >
        {label}
        {required && <span className="text-red-500 ml-1">*</span>}
      </label>
    </div>
  );
}
