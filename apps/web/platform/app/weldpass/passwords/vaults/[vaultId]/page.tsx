/**
 * WeldPass vault — the inside of one vault: its items, opened from the Vaults
 * page. The same list as the Passwords page, narrowed to this vault.
 */

import { useParams } from '@/lib/router';
import { PasswordsGate } from '../../components/passwords-gate';
import { PasswordsList } from '../../components/passwords-list';

export default function WeldPassVaultPage() {
  const { vaultId } = useParams() as { vaultId: string };

  return (
    <PasswordsGate pageLabel="WeldPass vault">
      <PasswordsList vaultId={vaultId} />
    </PasswordsGate>
  );
}
