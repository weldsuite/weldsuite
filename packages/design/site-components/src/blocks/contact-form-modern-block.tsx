"use client";

import React from 'react';
import { ContactFormModernSection } from '../sections/contact-form-modern-section';

interface FormField {
  id: string;
  type: 'text' | 'email' | 'select' | 'textarea' | 'tel' | 'number';
  label: string;
  placeholder?: string;
  required?: boolean;
  width?: 'half' | 'full';
  options?: string[];
}

interface ContactFormModernBlockProps {
  sectionId?: string;
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

export function ContactFormModernBlock(props: ContactFormModernBlockProps) {
  return <ContactFormModernSection {...props} />;
}
