import { HelpDocsPreviewClient } from './help-docs-preview-client';

/**
 * Public preview frames for help-center screenshots.
 * Route: /preview/help-docs?scene=domains|dns-list|dns-add|dns-locked
 */
export default function HelpDocsPreviewPage() {
  return (
    <div className="min-h-0 bg-[var(--shell-chrome)] p-4">
      <HelpDocsPreviewClient />
    </div>
  );
}
