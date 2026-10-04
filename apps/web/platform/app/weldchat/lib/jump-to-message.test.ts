import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findMessageElement, flashMessage, flashMessageWhenMounted } from './jump-to-message';

function addRow(id: string): HTMLElement {
  const row = document.createElement('div');
  row.setAttribute('data-message-id', id);
  row.scrollIntoView = vi.fn();
  document.body.appendChild(row);
  return row;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('jump-to-message', () => {
  it('finds a row by id without building a selector from it', () => {
    const row = addRow('msg_1');
    expect(findMessageElement('msg_1')).toBe(row);
    expect(findMessageElement('"] , body, ["')).toBeNull();
    expect(findMessageElement('msg_2')).toBeNull();
  });

  it('scrolls to the row and flashes it briefly', () => {
    const row = addRow('msg_1');
    expect(flashMessage('msg_1')).toBe(true);
    expect(row.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    expect(row.classList.contains('pinned-highlight')).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(row.classList.contains('pinned-highlight')).toBe(false);
  });

  it('reports a missing row', () => {
    expect(flashMessage('nope')).toBe(false);
  });

  it('waits for a row that mounts later', () => {
    flashMessageWhenMounted('msg_late', 10, 100);
    vi.advanceTimersByTime(250);
    const row = addRow('msg_late');
    vi.advanceTimersByTime(100);
    expect(row.scrollIntoView).toHaveBeenCalled();
  });

  it('can be cancelled and gives up after the attempts', () => {
    const cancel = flashMessageWhenMounted('msg_x', 3, 100);
    cancel();
    const row = addRow('msg_x');
    vi.advanceTimersByTime(1000);
    expect(row.scrollIntoView).not.toHaveBeenCalled();

    flashMessageWhenMounted('msg_y', 2, 100);
    vi.advanceTimersByTime(1000);
    const late = addRow('msg_y');
    vi.advanceTimersByTime(1000);
    expect(late.scrollIntoView).not.toHaveBeenCalled();
  });
});
