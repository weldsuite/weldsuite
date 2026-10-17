/**
 * The leading tile of a contact: a building for a company, a person for a
 * private individual. An older contact without a CRM record yet keeps the
 * building every contact used to show.
 */

import { Building2, User } from 'lucide-react-native';

import { ACCENTS } from '@/lib/brand';
import { IconTile } from '@/components/detail';
import type { ContactKind } from '@/types/accounting';

export function ContactKindTile({ kind, size }: Readonly<{ kind?: ContactKind; size?: number }>) {
  return <IconTile icon={kind === 'person' ? User : Building2} color={ACCENTS.contacts} size={size} />;
}
