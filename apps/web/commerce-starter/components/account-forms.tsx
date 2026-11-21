'use client';

import type { Shopper } from '@weldsuite/commerce-sdk';
import Link from 'next/link';
import { useActionState, useId } from 'react';

import {
  decideApprovalAction,
  reorderAction,
  selectCompanyAction,
  updateProfileAction,
  type ReorderState,
} from '@/lib/actions/account';
import { quickOrderAction, type QuickOrderState } from '@/lib/actions/cart';
import { idle } from '@/lib/actions/state';

import { Field, FormMessage, PendingButton, SubmitButton, submitKeepingValues, useFormFocus } from './form-bits';

export function ProfileForm({ shopper }: Readonly<{ shopper: Shopper }>) {
  const [state, action] = useActionState(updateProfileAction, idle);
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      <Field name="firstName" label="First name" autoComplete="given-name" maxLength={100} defaultValue={shopper.firstName ?? ''} />
      <Field name="lastName" label="Last name" autoComplete="family-name" maxLength={100} defaultValue={shopper.lastName ?? ''} />
      <Field
        className="sm:col-span-2"
        name="phone"
        label="Phone"
        optional
        type="tel"
        autoComplete="tel"
        maxLength={50}
        defaultValue={shopper.phone ?? ''}
      />
      <div className="sm:col-span-2">
        <FormMessage state={state} />
      </div>
      <div>
        <SubmitButton className="btn btn-secondary" pendingText="Saving…">
          Save your details
        </SubmitButton>
      </div>
    </form>
  );
}

const ROLES = { buyer: 'Buyer', approver: 'Approver', admin: 'Admin' } as const;

/** B2B: the company the shopper buys for. */
export function CompanyForm({ shopper }: Readonly<{ shopper: Shopper }>) {
  const [state, action] = useActionState(selectCompanyAction, idle);
  return (
    <form action={action} className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="label mb-2">Buying for</legend>
        {shopper.companies.map((company) => (
          <label
            key={company.id}
            className="flex cursor-pointer items-center gap-3 rounded-lg border-2 border-line px-4 py-3 has-checked:border-brand has-checked:bg-brand-soft"
          >
            <input type="radio" name="companyId" value={company.id} required defaultChecked={company.id === shopper.activeCompanyId} />
            <span className="flex-1 font-medium">{company.name}</span>
            <span className="hint">{ROLES[company.role] ?? company.role}</span>
          </label>
        ))}
      </fieldset>
      <FormMessage state={state} />
      <div>
        <SubmitButton className="btn btn-secondary" pendingText="Switching…">
          Buy for this company
        </SubmitButton>
      </div>
    </form>
  );
}

/** Order page: put the order's items in the cart again. */
export function ReorderForm({ orderId }: Readonly<{ orderId: string }>) {
  const [state, action] = useActionState<ReorderState, FormData>(reorderAction, idle);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="orderId" value={orderId} />
      <div>
        <SubmitButton pendingText="Adding to your cart…">Order these items again</SubmitButton>
      </div>
      <FormMessage state={state} />
      {(state.problems?.length ?? 0) > 0 ? (
        <ul className="list-disc pl-6 text-sm">
          {state.problems?.map((problem) => (
            <li key={problem.id}>
              {problem.sku ? <strong>{problem.sku}: </strong> : null}
              {problem.message}
            </li>
          ))}
        </ul>
      ) : null}
      {state.problems ? (
        <p>
          <Link href="/cart" className="font-medium text-brand underline underline-offset-4">
            Go to your cart
          </Link>
        </p>
      ) : null}
    </form>
  );
}

/**
 * Approvals: approve or reject one order, with an optional comment. The
 * decision is a radio choice plus one submit button (React leaves `name` off
 * submit buttons in a form with a function action, so two named buttons
 * would not say which was pressed).
 */
export function ApprovalForm({ orderId, orderNumber }: Readonly<{ orderId: string; orderNumber: string }>) {
  const [state, action, pending] = useActionState(decideApprovalAction, idle);
  const id = useId();
  return (
    <form action={action} onSubmit={submitKeepingValues(action)} className="flex flex-col gap-3">
      <input type="hidden" name="orderId" value={orderId} />
      <fieldset className="flex flex-wrap gap-3">
        <legend className="label mb-2">Your decision on order {orderNumber}</legend>
        <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border-2 border-line px-3 has-checked:border-brand has-checked:bg-brand-soft">
          <input type="radio" name="decision" value="approve" required />
          <span>Approve</span>
        </label>
        <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border-2 border-line px-3 has-checked:border-danger has-checked:bg-danger-soft">
          <input type="radio" name="decision" value="reject" required />
          <span>Reject</span>
        </label>
      </fieldset>
      <div className="field">
        <label htmlFor={id}>
          Comment <span className="hint font-normal">(optional)</span>
        </label>
        <textarea id={id} name="comment" rows={2} maxLength={1000} />
      </div>
      <FormMessage state={state} />
      <div>
        <PendingButton pending={pending} pendingText="Saving…">
          Save decision<span className="sr-only"> on order {orderNumber}</span>
        </PendingButton>
      </div>
    </form>
  );
}

/** B2B quick order: SKUs and quantities, pasted or as a CSV file. */
export function QuickOrderForm() {
  const [state, action, pending] = useActionState<QuickOrderState, FormData>(quickOrderAction, idle);
  const form = useFormFocus(state);
  const csvId = useId();
  const hintId = useId();
  const fileId = useId();
  return (
    <div className="flex flex-col gap-6">
      <form ref={form} action={action} onSubmit={submitKeepingValues(action)} className="flex flex-col gap-4">
        <div className="field">
          <label htmlFor={csvId}>SKUs and quantities</label>
          <p id={hintId} className="hint">
            One product per line: the SKU, a comma, the quantity. For example <code>CHAIR-01,12</code>. Pasting two columns
            from a spreadsheet works too. Up to 500 lines.
          </p>
          <textarea
            id={csvId}
            name="csv"
            rows={10}
            spellCheck={false}
            autoCapitalize="characters"
            aria-describedby={hintId}
            aria-invalid={state.fieldErrors?.csv ? true : undefined}
            className="font-mono"
          />
        </div>
        <div className="field">
          <label htmlFor={fileId}>
            Or upload a CSV file <span className="hint font-normal">(optional)</span>
          </label>
          <input id={fileId} name="file" type="file" accept=".csv,text/csv" />
        </div>
        <FormMessage state={state} />
        <div>
          <PendingButton pending={pending} pendingText="Adding…">
            Add to cart
          </PendingButton>
        </div>
      </form>

      {(state.problems?.length ?? 0) > 0 ? (
        <section aria-labelledby="problems" className="flex flex-col gap-3">
          <h2 id="problems" className="text-lg font-semibold">
            Lines to check
          </h2>
          {/* tabIndex: keyboard users can scroll a table wider than the screen (a focusable region). */}
          <div role="region" aria-labelledby="problems" tabIndex={0} className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-line text-sm text-ink-muted">
                  <th scope="col" className="py-2 pr-4 font-medium">Line</th>
                  <th scope="col" className="py-2 pr-4 font-medium">SKU</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Problem</th>
                  <th scope="col" className="py-2 font-medium">In your cart</th>
                </tr>
              </thead>
              <tbody>
                {state.problems?.map((problem) => (
                  <tr key={problem.id} className="border-b border-line">
                    <td className="py-2 pr-4 tabular-nums">{problem.row ?? '–'}</td>
                    <th scope="row" className="py-2 pr-4 font-mono font-normal">{problem.sku ?? '–'}</th>
                    <td className="py-2 pr-4">{problem.message}</td>
                    <td className="py-2">{problem.added ? 'Yes, fewer in stock' : 'No'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      {state.added !== undefined ? (
        <p>
          <Link href="/cart" className="btn btn-secondary">
            Go to your cart
          </Link>
        </p>
      ) : null}
    </div>
  );
}
