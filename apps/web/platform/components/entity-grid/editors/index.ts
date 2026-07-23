export { TextEditor } from './text-editor';
export { EmailEditor } from './email-editor';
export { PhoneEditor } from './phone-editor';
export { NumberEditor } from './number-editor';
export { CurrencyEditor } from './currency-editor';
export { DateEditor } from './date-editor';
export { SelectEditor } from './select-editor';
export { MultiSelectEditor } from './multi-select-editor';
export { CheckboxEditor } from './checkbox-editor';
export { LocationEditor } from './location-editor';
export { UrlEditor } from './url-editor';

import { FieldType } from '../types';
import { TextEditor } from './text-editor';
import { EmailEditor } from './email-editor';
import { PhoneEditor } from './phone-editor';
import { NumberEditor } from './number-editor';
import { CurrencyEditor } from './currency-editor';
import { DateEditor } from './date-editor';
import { SelectEditor } from './select-editor';
import { MultiSelectEditor } from './multi-select-editor';
import { CheckboxEditor } from './checkbox-editor';
import { LocationEditor } from './location-editor';
import { UrlEditor } from './url-editor';

// Editor registry - maps field types to editor components
const editorRegistry: Record<FieldType, React.ComponentType<any>> = {
  text: TextEditor,
  email: EmailEditor,
  phone: PhoneEditor,
  number: NumberEditor,
  currency: CurrencyEditor,
  percent: NumberEditor,
  date: DateEditor,
  'single-select': SelectEditor,
  'multi-select': MultiSelectEditor,
  checkbox: CheckboxEditor,
  location: LocationEditor,
  url: UrlEditor,
  company: TextEditor,
  rating: NumberEditor,
};

// Get editor for a field type
function getEditorForFieldType(type: FieldType): React.ComponentType<any> {
  return editorRegistry[type] || TextEditor;
}
