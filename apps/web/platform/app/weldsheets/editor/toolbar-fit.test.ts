import { describe, expect, it } from 'vitest';
import { fitGroups } from './toolbar-fit';

describe('fitGroups', () => {
  const widths = [100, 100, 100, 100];

  it('keeps everything when it fits', () => {
    expect(fitGroups(widths, 406, 28)).toBe(4);
  });

  it('moves the rest behind More, leaving room for the button', () => {
    expect(fitGroups(widths, 300, 28)).toBe(2);
    expect(fitGroups(widths, 50, 28)).toBe(0);
  });
});
