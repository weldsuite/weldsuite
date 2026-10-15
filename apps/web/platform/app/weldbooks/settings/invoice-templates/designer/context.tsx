import { createContext, useContext } from 'react';
import type { TemplateField, TemplateTheme } from '@weldsuite/books-domain/invoice-template/schema';

export interface DesignerContextValue {
  theme: TemplateTheme;
  /** The viewer cannot change templates, or the screen is too narrow to design on. */
  readOnly: boolean;
  /** Translated names of the template fields. */
  fieldNames: Record<TemplateField, string>;
  /** Uploads a PNG or JPEG and resolves with its public URL; rejects with a translated message. */
  uploadImage: (file: File) => Promise<string>;
}

const DesignerContext = createContext<DesignerContextValue | null>(null);

export const DesignerProvider = DesignerContext.Provider;

export function useDesigner(): DesignerContextValue {
  const value = useContext(DesignerContext);
  if (!value) throw new Error('useDesigner must be used inside the invoice designer');
  return value;
}
