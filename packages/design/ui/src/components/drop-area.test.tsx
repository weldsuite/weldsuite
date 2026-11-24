import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DropArea, DropAreaOverlay } from './drop-area';

afterEach(cleanup);

const photo = new File(['png'], 'photo.png', { type: 'image/png' });
const notes = new File(['txt'], 'notes.txt', { type: 'text/plain' });

/** A drag from outside the browser carrying `files`, as react-dropzone reads it. */
function dataTransfer(files: File[]) {
  return {
    files,
    items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
    types: ['Files'],
  };
}

function renderArea(onDrop = vi.fn(), options?: Parameters<typeof DropArea>[0]['options']) {
  render(
    <DropArea onDrop={onDrop} options={options} className="h-full" data-testid="area">
      <p>The conversation</p>
      <DropAreaOverlay title="Upload to #general" description="Files wait in the composer" icon={<svg data-testid="icon" />} />
    </DropArea>,
  );
  return { onDrop, area: screen.getByTestId('area') };
}

describe('DropArea', () => {
  it('shows its content and no overlay until files are dragged over it', () => {
    const { area } = renderArea();
    expect(screen.getByText('The conversation')).toBeTruthy();
    expect(screen.queryByText('Upload to #general')).toBeNull();
    expect(area.dataset.slot).toBe('drop-area');
    expect(area.dataset.dragActive).toBeUndefined();
    expect(area.className).toContain('relative');
    expect(area.className).toContain('h-full');
  });

  it('covers the area with the overlay while files are over it, hidden from assistive technology', async () => {
    const { area } = renderArea();
    fireEvent.dragEnter(area, { dataTransfer: dataTransfer([photo]) });

    await waitFor(() => expect(screen.getByText('Upload to #general')).toBeTruthy());
    expect(area.dataset.dragActive).toBe('true');
    expect(screen.getByText('Files wait in the composer')).toBeTruthy();
    expect(screen.getByTestId('icon')).toBeTruthy();
    const overlay = area.querySelector('[data-slot="drop-area-overlay"]');
    expect(overlay?.getAttribute('aria-hidden')).toBe('true');
  });

  it('hands the dropped files over', async () => {
    const { area, onDrop } = renderArea();
    fireEvent.drop(area, { dataTransfer: dataTransfer([photo, notes]) });

    await waitFor(() => expect(onDrop).toHaveBeenCalledWith([photo, notes]));
  });

  it('ignores a drop when no file is accepted', async () => {
    const { area, onDrop } = renderArea(vi.fn(), { accept: { 'image/*': [] } });
    fireEvent.drop(area, { dataTransfer: dataTransfer([notes]) });

    // react-dropzone reads the files asynchronously; give it the chance to call back.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('leaves clicks to the content', () => {
    const onClick = vi.fn();
    render(
      <DropArea onDrop={vi.fn()}>
        <button type="button" onClick={onClick}>
          Send
        </button>
      </DropArea>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });
});

describe('DropAreaOverlay', () => {
  it('renders nothing outside a DropArea', () => {
    const { container } = render(<DropAreaOverlay title="Upload" />);
    expect(container.innerHTML).toBe('');
  });

  it('leaves out the description line when there is none', async () => {
    render(
      <DropArea onDrop={vi.fn()} data-testid="area">
        <DropAreaOverlay title="Upload to this thread" className="rounded-lg" />
      </DropArea>,
    );
    fireEvent.dragEnter(screen.getByTestId('area'), { dataTransfer: dataTransfer([photo]) });

    const title = await screen.findByText('Upload to this thread');
    const panel = title.parentElement;
    expect(panel?.querySelectorAll('p')).toHaveLength(1);
    expect(panel?.parentElement?.className).toContain('rounded-lg');
  });
});
