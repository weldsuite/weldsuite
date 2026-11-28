import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DocumentViewer, documentKind, stepZoom, type DocumentViewerLabels } from './document-viewer';

afterEach(cleanup);

const labels: DocumentViewerLabels = {
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  fit: 'Fit',
  rotate: 'Rotate',
  previousPage: 'Previous page',
  nextPage: 'Next page',
  page: 'Page number',
  toolbar: 'Document tools',
  document: 'Original document',
  open: 'Open in a new tab',
  failed: 'Cannot show this file',
  pageOf: 'of {count}',
};

describe('documentKind', () => {
  it('reads the kind from the type, then from the file name', () => {
    expect(documentKind({ mimeType: 'image/png' })).toBe('image');
    expect(documentKind({ mimeType: 'application/pdf' })).toBe('pdf');
    expect(documentKind({ fileName: 'scan.JPG' })).toBe('image');
    expect(documentKind({ fileName: 'invoice.pdf' })).toBe('pdf');
    expect(documentKind({})).toBe('pdf');
  });
});

describe('stepZoom', () => {
  it('moves one step and stays inside the limits', () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.75);
    expect(stepZoom(4, 1)).toBe(4);
    expect(stepZoom(0.5, -1)).toBe(0.5);
  });
});

describe('DocumentViewer', () => {
  it('shows an image with zoom and rotate that the toolbar and the keys change', () => {
    render(<DocumentViewer src="/files/receipt.png" mimeType="image/png" labels={labels} />);
    const image = screen.getByRole('img', { name: 'Original document' });
    expect(image.getAttribute('src')).toBe('/files/receipt.png');
    expect(screen.getByRole('toolbar', { name: 'Document tools' })).toBeTruthy();
    expect(screen.getByText('100%')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByText('125%')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(screen.getByText('75%')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
    expect(image.style.rotate).toBe('90deg');

    fireEvent.click(screen.getByRole('button', { name: 'Fit' }));
    expect(screen.getByText('100%')).toBeTruthy();
    expect(image.style.rotate).toBe('0deg');

    const area = screen.getByRole('region', { name: 'Original document' });
    fireEvent.keyDown(area, { key: '+' });
    expect(screen.getByText('125%')).toBeTruthy();
    fireEvent.keyDown(area, { key: 'r' });
    expect(image.style.rotate).toBe('90deg');
    fireEvent.keyDown(area, { key: '0' });
    expect(screen.getByText('100%')).toBeTruthy();
  });

  it('stops zooming at the limits', () => {
    render(<DocumentViewer src="/files/receipt.png" kind="image" labels={labels} />);
    const out = screen.getByRole('button', { name: 'Zoom out' });
    fireEvent.click(out);
    fireEvent.click(out);
    expect(screen.getByText('50%')).toBeTruthy();
    expect((out as HTMLButtonElement).disabled).toBe(true);
  });

  it('opens a PDF at its page and moves between pages up to the last', () => {
    render(<DocumentViewer src="/files/invoice.pdf" mimeType="application/pdf" pageCount={3} labels={labels} />);
    const frame = () => screen.getByTitle('Original document');
    expect(frame().getAttribute('src')).toContain('#page=1');
    expect(screen.getByText('of 3')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Previous page' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(frame().getAttribute('src')).toContain('#page=2');
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Page number' }), { target: { value: '9' } });
    expect(frame().getAttribute('src')).toContain('#page=3');
    expect((screen.getByRole('button', { name: 'Next page' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('has no page buttons for an image', () => {
    render(<DocumentViewer src="/files/receipt.png" kind="image" labels={labels} />);
    expect(screen.queryByRole('button', { name: 'Next page' })).toBeNull();
  });

  it('links to the file and falls back to that link when it cannot be shown', () => {
    render(<DocumentViewer src="/files/broken.png" kind="image" labels={labels} />);
    expect(screen.getByRole('link', { name: 'Open in a new tab' }).getAttribute('href')).toBe('/files/broken.png');
    fireEvent.error(screen.getByRole('img', { name: 'Original document' }));
    expect(screen.getByText('Cannot show this file')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Open in a new tab' }).length).toBeGreaterThan(1);
  });

  it('starts from the top again for another file', () => {
    const { rerender } = render(<DocumentViewer src="/a.pdf" kind="pdf" pageCount={5} labels={labels} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    rerender(<DocumentViewer src="/b.pdf" kind="pdf" pageCount={5} labels={labels} />);
    expect(screen.getByTitle('Original document').getAttribute('src')).toContain('/b.pdf#page=1');
    expect(screen.getByText('100%')).toBeTruthy();
  });
});
