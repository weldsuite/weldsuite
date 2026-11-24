import type { WeldPassVault } from '@weldsuite/app-api-client/domains/weldpass-passwords';

import type { Translations } from '@/lib/i18n';

/** The personal vault is named by what it is, not by its stored name. */
export function vaultLabel(t: Translations, vault: Pick<WeldPassVault, 'kind' | 'name'>): string {
  return vault.kind === 'personal' ? t.vaults.personal : vault.name;
}
