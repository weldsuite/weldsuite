import { useShop } from '@weldsuite/storefront-theme'
import { useId } from 'react'
import { quickOrder } from '@/lib/server/actions/cart'
import { FormMessage, ShopForm, SubmitButton, useFormState } from '../shop-form'
import { QueryError } from '../template-view'

function Lines() {
  const { shop } = useShop()
  const s = shop.strings.b2b
  const id = useId()
  const { result } = useFormState()
  const error = result && !result.ok ? result.fieldErrors?.csv : undefined
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="shop-label">
        {s.lines}
      </label>
      <textarea
        id={id}
        name="csv"
        rows={10}
        spellCheck={false}
        autoCapitalize="characters"
        aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`}
        aria-invalid={error ? true : undefined}
        className="shop-input font-mono"
      />
      <p id={`${id}-hint`} className="shop-hint">
        {s.linesHint}
      </p>
      {error ? (
        <p id={`${id}-error`} className="shop-field-error">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/** B2B quick order: SKUs and quantities, pasted or as a CSV file. */
export function QuickOrderPage() {
  const { shop } = useShop()
  const s = shop.strings.b2b
  const fileId = useId()
  return (
    <div className="shop-container shop-section flex max-w-3xl flex-col gap-6">
      <QueryError />
      <h1 className="text-3xl font-semibold md:text-4xl">{s.quickOrderTitle}</h1>
      <p>{s.quickOrderIntro}</p>
      <ShopForm action={quickOrder} resetOnSuccess className="flex flex-col gap-5">
        <Lines />
        <div className="flex flex-col gap-1.5">
          <label htmlFor={fileId} className="shop-label">
            {s.file} <span className="shop-hint font-normal">({shop.strings.common.optional})</span>
          </label>
          <input id={fileId} type="file" name="file" accept=".csv,text/csv,text/plain" className="shop-input" />
        </div>
        <FormMessage />
        <div>
          <SubmitButton pendingText={s.adding}>{s.addLines}</SubmitButton>
        </div>
      </ShopForm>
    </div>
  )
}
