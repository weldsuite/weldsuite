import { generatePassword } from '@weldsuite/app-api-client/schemas/weldpass-passwords';
import { installRandomValues } from '@/lib/polyfills';

jest.mock('expo-crypto', () => ({
  getRandomValues: jest.fn((array: Uint8Array) => {
    for (let i = 0; i < array.length; i++) array[i] = (i * 37 + 11) % 256;
    return array;
  }),
}));

describe('crypto.getRandomValues on the phone', () => {
  it('is installed from expo-crypto where the runtime has none', () => {
    const target: { crypto?: unknown } = {};
    installRandomValues(target);
    const crypto = target.crypto as { getRandomValues: (array: Uint8Array) => Uint8Array };
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    expect(Array.from(bytes)).toEqual([11, 48, 85, 122]);
  });

  it("leaves a runtime's own implementation alone", () => {
    const own = jest.fn();
    const target: { crypto?: unknown } = { crypto: { getRandomValues: own, subtle: 'kept' } };
    installRandomValues(target);
    expect((target.crypto as { getRandomValues: unknown }).getRandomValues).toBe(own);
  });

  it('lets the shared password generator run', () => {
    const password = generatePassword({ length: 24 });
    expect(password).toHaveLength(24);
    expect(password).toMatch(/[a-z]/);
    expect(password).toMatch(/[A-Z]/);
    expect(password).toMatch(/[2-9]/);
  });
});
