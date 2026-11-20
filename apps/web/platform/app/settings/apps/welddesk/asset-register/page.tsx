import { AssetRegisterCard } from '../asset-register-card';
import { IntuneSection } from './intune-section';

/**
 * Settings → Apps → WeldDesk → Asset register: the register's state (set up /
 * open assets) and the device import from Microsoft Intune.
 */
export default function AssetRegisterSettingsPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-8" data-testid="asset-register-settings">
      <AssetRegisterCard />
      <IntuneSection />
    </div>
  );
}
