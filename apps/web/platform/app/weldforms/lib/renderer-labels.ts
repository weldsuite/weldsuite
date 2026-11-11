/**
 * The renderer's own texts in the language of the form (not of the member who
 * builds it): `definition.presentation.language`, en or nl. Also used by the
 * members-only fill page.
 */

import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import type { FormRendererLabels } from '@weldsuite/forms-renderer';
import type { FormLanguage } from '@weldsuite/forms-engine';

export function getRendererLabels(language: FormLanguage): FormRendererLabels {
  return (language === 'nl' ? nl : en).weldforms.renderer;
}
