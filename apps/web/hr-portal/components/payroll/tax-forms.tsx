'use client';

import { useI18n } from '@/lib/i18n';
import type { HrMyPayrollDetails, HrTaxElection, HrTaxElectionKind } from '@/lib/payroll/types';
import { NlTaxFormCard } from '@/components/payroll/nl-tax-form';
import { UsStateCertificateCard, UsW4Card } from '@/components/payroll/us-tax-forms';

/** The election of this kind (and state) in force, or null when none is signed. */
function findElection(elections: HrTaxElection[], kind: HrTaxElectionKind, state: string | null): HrTaxElection | null {
  const matches = elections.filter(
    (election) => election.kind === kind && (election.state?.toUpperCase() ?? null) === state,
  );
  matches.sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.createdAt.localeCompare(a.createdAt));
  return matches[0] ?? null;
}

/** Every state with a certificate to sign or already signed, in a stable order. */
function certificateStates(details: HrMyPayrollDetails): string[] {
  const states = new Set<string>();
  for (const required of details.requiredElections) {
    if (required.kind === 'us_state_certificate' && required.state) states.add(required.state.toUpperCase());
  }
  for (const election of details.elections) {
    if (election.kind === 'us_state_certificate' && election.state) states.add(election.state.toUpperCase());
  }
  return [...states].sort();
}

/**
 * The tax forms the employee signs themselves: NL the loonheffingskorting
 * choice, US the federal W-4 plus the withholding certificate of each state
 * that asks for one.
 */
export function TaxForms({ slug, details }: Readonly<{ slug: string; details: HrMyPayrollDetails }>) {
  const { dict } = useI18n();
  if (details.country === null) return null;

  return (
    <section aria-labelledby="tax-forms-heading" className="space-y-4">
      <div>
        <h2 id="tax-forms-heading" className="font-medium text-gray-900">
          {dict.payroll.taxForms.title}
        </h2>
        <p className="text-sm text-gray-500">{dict.payroll.taxForms.intro}</p>
      </div>

      {details.country === 'NL' ? (
        <NlTaxFormCard
          slug={slug}
          employerName={details.employerName}
          election={findElection(details.elections, 'nl_loonheffingskorting', null)}
        />
      ) : (
        <>
          <UsW4Card slug={slug} election={findElection(details.elections, 'us_w4', null)} />
          {certificateStates(details).map((state) => (
            <UsStateCertificateCard
              key={state}
              slug={slug}
              state={state}
              election={findElection(details.elections, 'us_state_certificate', state)}
            />
          ))}
        </>
      )}
    </section>
  );
}
