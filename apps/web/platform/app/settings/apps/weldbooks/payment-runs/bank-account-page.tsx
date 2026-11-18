import { WeldbooksSettingsScope } from '../entity-scope';
import PaymentSettingsPage from './[bankAccountId]/page';

/** Settings → Apps → WeldBooks → payment settings of one bank account, scoped to the selected legal entity. */
export default function WeldbooksBankAccountSettingsPage() {
  return (
    <div className="min-w-0 space-y-6">
      <WeldbooksSettingsScope>
        <PaymentSettingsPage />
      </WeldbooksSettingsScope>
    </div>
  );
}
