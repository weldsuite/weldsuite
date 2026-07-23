/**
 * Core types for the Object Template system.
 *
 * An "object template" is a named, ordered subset of fields that pre-fills a
 * quick-add form for a given object type (Companies, People, and — in the
 * future — Deals, Tickets, Products, etc.). The system is intentionally
 * generic: each module contributes a field catalog and a one-line
 * registration; the settings UI, quick-add dialogs and the storage layer
 * handle the rest.
 */

import type { LucideIcon } from 'lucide-react';

export type TemplateInputType = 'text' | 'email' | 'url' | 'phone' | 'textarea' | 'number';

/**
 * A single field that can appear in a template for a given object type.
 *
 * - `slug` must match the API key used when creating the object — the
 *   renderer registers it as the form field name directly.
 * - `required: true` means the field is always part of every template and
 *   always renders in the quick-add dialog, regardless of which template (if
 *   any) the user picked.
 */
export interface TemplateFieldSpec {
  slug: string;
  label: string;
  group: string;
  inputType: TemplateInputType;
  required?: boolean;
  placeholder?: string;
}

/**
 * Module-level registration. One per templated object type.
 *
 * Add a new templated object by creating a field catalog in your module and
 * appending an entry to `TEMPLATE_REGISTRATIONS` in `registry.ts`.
 */
export interface TemplateEntityRegistration {
  /** Stable identifier — stored verbatim in `object_templates.entity_type`. */
  value: string;
  /** Plural label shown in the settings entity picker, e.g. "Companies". */
  label: string;
  /** Singular noun used in copy, e.g. "company". */
  singular: string;
  icon: LucideIcon;
  /** Built-in fields available to templates for this object. */
  fields: TemplateFieldSpec[];
  /** Slugs shown by the quick-add dialog when no template is picked. */
  defaultFields: string[];
}
