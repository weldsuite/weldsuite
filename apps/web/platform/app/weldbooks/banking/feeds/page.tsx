import { BankFeedsPanel } from './bank-feeds-panel';

/** Bank feeds: every bank connection of the entity, with Connect bank. */
export default function BankFeedsPage() {
  return (
    <div className="mx-auto w-full max-w-4xl p-4 sm:p-6">
      <BankFeedsPanel />
    </div>
  );
}
