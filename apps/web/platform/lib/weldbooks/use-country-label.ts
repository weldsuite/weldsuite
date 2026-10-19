import { countryName } from '@/components/address/countries';
import { useI18n } from '@/lib/i18n/provider';

/** Localised country name lookup in the member's language. */
export function useCountryLabel() {
  const { language } = useI18n();
  return (code: string) => countryName(code, language || 'en');
}
