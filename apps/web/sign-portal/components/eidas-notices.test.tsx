import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { dictionaries } from '@/lib/i18n'
import { LevelNotice, ReturnedNotice } from './eidas-notices'

afterEach(cleanup)

describe.each(['en', 'nl'] as const)('eIDAS notices (%s)', (locale) => {
  const t = dictionaries[locale]

  it('says which level is asked and where the signer confirms who they are', () => {
    render(<LevelNotice level="qes" provider="Test QTSP" t={t} />)
    expect(screen.getByText(`${t.eidas.levelTitle.qes}.`, { exact: false })).toBeTruthy()
    expect(screen.getByText(t.eidas.confirmWith('Test QTSP'), { exact: false })).toBeTruthy()
  })

  it('has a wording without a provider name', () => {
    render(<LevelNotice level="aes" provider={null} t={t} />)
    expect(screen.getByText(t.eidas.confirmWithoutProvider, { exact: false })).toBeTruthy()
  })

  it('tells a signer back from the provider what happened', () => {
    const { unmount } = render(<ReturnedNotice returned="failed" provider="Test QTSP" t={t} />)
    expect(screen.getByRole('alert').textContent).toBe(t.eidas.returnedFailed('Test QTSP'))
    unmount()
    render(<ReturnedNotice returned="failed" provider={null} t={t} />)
    expect(screen.getByRole('alert').textContent).toBe(t.eidas.returnedFailed(null))
    cleanup()
    render(<ReturnedNotice returned="cancelled" provider={null} t={t} />)
    expect(screen.getByRole('alert').textContent).toBe(t.eidas.returnedCancelled)
  })

  it('words the Finish button for a provider and without one', () => {
    expect(t.eidas.finish('Test QTSP')).toContain('Test QTSP')
    expect(t.eidas.finish(null)).not.toContain('null')
    expect(t.eidas.returnedFailed('Test QTSP')).not.toBe(t.eidas.returnedFailed(null))
  })
})
