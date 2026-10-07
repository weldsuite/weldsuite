/**
 * WeldPass passwords — the team password manager's item list: every item the
 * caller can see, across all their vaults. Vaults themselves are managed on
 * the Vaults page, and each one opens to its own items there.
 */

import { PasswordsGate } from './components/passwords-gate';
import { PasswordsList } from './components/passwords-list';

export default function WeldPassPasswordsPage() {
  return (
    <PasswordsGate pageLabel="WeldPass passwords">
      <PasswordsList />
    </PasswordsGate>
  );
}
