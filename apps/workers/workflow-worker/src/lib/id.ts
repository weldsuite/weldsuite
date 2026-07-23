import { customAlphabet } from 'nanoid';

// 24-char base62 body → `prefix_xxxxxxxxxxxxxxxxxxxxxxxx`, matching the
// `generateId('prefix')` convention used across WeldSuite (varchar(30) ids).
const nanoid = customAlphabet(
  '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
  24,
);

export function generateId(prefix: string): string {
  return `${prefix}_${nanoid()}`;
}
