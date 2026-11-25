import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Suspense, type ComponentType } from 'react';

interface Registration {
  type: string;
  label: string;
  component: ComponentType<{ id: string }>;
}

const registered = vi.hoisted(() => [] as unknown[]);

vi.mock('@/components/object-panel', () => ({
  registerObjectPanel: (registration: unknown) => registered.push(registration),
}));
vi.mock('./parcel-panel', () => ({
  ParcelPanel: ({ id }: { id: string }) => <p>{`panel ${id}`}</p>,
}));

import { ParcelPanel } from './index';

describe('parcel object panel registration', () => {
  it('registers the lazily loaded panel under the parcel type', async () => {
    expect(registered).toHaveLength(1);
    const registration = registered[0] as Registration;
    expect(registration.type).toBe('parcel');
    expect(registration.label).toBe('Parcel');

    const Lazy = registration.component;
    render(
      <Suspense fallback={<p>loading</p>}>
        <Lazy id="parcel_1" />
      </Suspense>,
    );
    expect(await screen.findByText('panel parcel_1')).toBeInTheDocument();
  });

  it('exports the panel', () => {
    expect(ParcelPanel).toBeDefined();
  });
});
