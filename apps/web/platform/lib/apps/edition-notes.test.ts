import { afterEach, describe, expect, it } from 'vitest';
import { setRuntimeConfig } from '@/lib/runtime-config';
import { unavailableListedFeatures } from './edition-notes';

afterEach(() => setRuntimeConfig(null));

describe('unavailableListedFeatures', () => {
  it('names nothing on Global', () => {
    expect(unavailableListedFeatures('weldmeet')).toEqual([]);
    expect(unavailableListedFeatures('weldcall')).toEqual([]);
  });

  it("names what an edition lacks of an app's listing, and only that", () => {
    setRuntimeConfig({
      backend: 'rust',
      edition: 'eu',
      unavailableFeatures: ['meet-recordings', 'meet-transcription', 'phone-number-purchase', 'billing'],
    });
    expect(unavailableListedFeatures('weldmeet')).toEqual(['meet-recordings', 'meet-transcription']);
    expect(unavailableListedFeatures('WeldCall')).toEqual(['phone-number-purchase']);
    expect(unavailableListedFeatures('weldhost')).toEqual([]);
    expect(unavailableListedFeatures('my-custom-app')).toEqual([]);
  });
});
