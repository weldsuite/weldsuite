import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FormTabFrame } from './form-gate';

describe('FormTabFrame', () => {
  // The form shell clips its tabs to the screen, so Share, Integrations and Results scroll here or not at all.
  it('scrolls its own content', () => {
    const { container } = render(
      <FormTabFrame>
        <p>Long page</p>
      </FormTabFrame>,
    );
    const frame = container.firstElementChild as HTMLElement;
    expect(frame.classList.contains('h-full')).toBe(true);
    expect(frame.classList.contains('overflow-y-auto')).toBe(true);
  });
});
