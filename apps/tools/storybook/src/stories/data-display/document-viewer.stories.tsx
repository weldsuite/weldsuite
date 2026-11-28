import type { Meta, StoryObj } from '@storybook/react';

import { DocumentViewer, type DocumentViewerLabels } from '@weldsuite/ui/components/document-viewer';

const labels: DocumentViewerLabels = {
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  fit: 'Fit to view',
  rotate: 'Rotate',
  previousPage: 'Previous page',
  nextPage: 'Next page',
  page: 'Page number',
  toolbar: 'Document tools',
  document: 'Original document',
  open: 'Open in a new tab',
  failed: 'This file cannot be shown here.',
  pageOf: 'of {count}',
};

/** A receipt drawn as an SVG, so the story needs no file. */
const RECEIPT = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="640" viewBox="0 0 480 640">
    <rect width="480" height="640" fill="#fff"/>
    <text x="40" y="70" font-family="sans-serif" font-size="28" font-weight="700">Paper Co</text>
    <text x="40" y="110" font-family="sans-serif" font-size="16" fill="#555">Invoice INV-7 · 20 Nov 2026</text>
    <line x1="40" y1="140" x2="440" y2="140" stroke="#ccc"/>
    <text x="40" y="180" font-family="sans-serif" font-size="18">Copy paper A4 (5 reams)</text>
    <text x="440" y="180" font-family="sans-serif" font-size="18" text-anchor="end">€ 182.64</text>
    <text x="40" y="215" font-family="sans-serif" font-size="18">VAT 21%</text>
    <text x="440" y="215" font-family="sans-serif" font-size="18" text-anchor="end">€ 38.36</text>
    <line x1="40" y1="245" x2="440" y2="245" stroke="#ccc"/>
    <text x="40" y="285" font-family="sans-serif" font-size="22" font-weight="700">Total</text>
    <text x="440" y="285" font-family="sans-serif" font-size="22" font-weight="700" text-anchor="end">€ 221.00</text>
  </svg>`,
)}`;

const meta = {
  title: 'Data Display/DocumentViewer',
  component: DocumentViewer,
  args: { src: RECEIPT, kind: 'image', labels },
  decorators: [
    (Story) => (
      <div className="max-w-xl" style={{ ['--document-viewer-height' as string]: '28rem' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DocumentViewer>;

export default meta;
type Story = StoryObj<typeof meta>;

/** An image: zoom, rotate and fit from the toolbar, or `+`, `-`, `0` and `r` with the area focused. */
export const Image: Story = {};

/** A PDF opens in the browser's own viewer at the chosen page; pass `pageCount` when it is known. */
export const Pdf: Story = {
  args: { src: '/sample-invoice.pdf', kind: 'pdf', pageCount: 3 },
};

/** A file that fails to load shows why and keeps the link to open it. */
export const CannotShow: Story = { args: { src: '/missing.png' } };
