import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';

/**
 * Links into the agency setup screens, which are built next to the Sales Tax
 * Center (`app/weldbooks/sales-tax/agencies`) and are not part of this
 * module's routes. The paths are kept in one place, and typed loosely here so
 * a change to those screens' search parameters does not break this module.
 */

/** The agency list. */
export const AGENCIES_PATH = '/weldbooks/sales-tax/agencies';
/** The new-agency form; `?state=XX` fills in the state. */
export const NEW_AGENCY_PATH = '/weldbooks/sales-tax/agencies/new';

interface SetupLinkProps {
  className?: string;
  children: ReactNode;
}

/** The agency list. */
export function AgenciesLink({ className, children }: Readonly<SetupLinkProps>) {
  return (
    <Link to={AGENCIES_PATH as '/'} className={className}>
      {children}
    </Link>
  );
}

/** Register a state: the new-agency form with the state filled in. */
export function RegisterStateLink({ stateCode, className, children }: Readonly<SetupLinkProps & { stateCode: string }>) {
  return (
    <Link to={NEW_AGENCY_PATH as '/'} search={{ state: stateCode } as never} className={className}>
      {children}
    </Link>
  );
}
