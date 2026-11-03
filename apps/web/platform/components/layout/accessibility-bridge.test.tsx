import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@weldsuite/ui/components/dialog';
import { StatusDot } from '@weldsuite/ui/components/status-dot';
import { AccessibilityBridge } from './accessibility-bridge';

afterEach(() => {
  cleanup();
  document.documentElement.lang = 'en';
});

function renderInDutch() {
  render(
    <I18nProvider initialLanguage="nl">
      <AccessibilityBridge>
        {/* Inside the dialog: a modal dialog hides everything outside it. */}
        <Dialog open>
          <DialogContent>
            <DialogTitle>Titel</DialogTitle>
            <DialogDescription>Omschrijving</DialogDescription>
            <StatusDot status="dnd" />
            <StatusDot status="online" decorative />
          </DialogContent>
        </Dialog>
      </AccessibilityBridge>
    </I18nProvider>,
  );
}

describe('AccessibilityBridge', () => {
  it('sets <html lang> to the active locale', async () => {
    renderInDutch();
    await waitFor(() => expect(document.documentElement.lang).toBe('nl'));
  });

  it('gives the shared ui components their translated labels', async () => {
    renderInDutch();
    expect(await screen.findByRole('button', { name: 'Sluiten' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Niet storen' })).toBeTruthy();
    // A decorative dot is hidden, so only the one status image is named.
    expect(screen.getAllByRole('img')).toHaveLength(1);
  });
});
