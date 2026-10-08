import { describe, expect, it } from 'vitest';
import { daysApart, nameConfidence, nameSimilarity, nameTokens } from './accounting-bank-similarity';

describe('name tokens', () => {
  it('drops punctuation, legal suffixes and numbers', () => {
    expect(nameTokens('Smith & Sons Plumbing, LLC')).toEqual(['smith', 'sons', 'plumbing']);
    expect(nameTokens('ACME Corp. #1042')).toEqual(['acme']);
  });

  it('drops the bank words when asked', () => {
    expect(nameTokens('ACH CREDIT ACME CORP INV 2001', { dropNoise: true })).toEqual(['acme']);
  });
});

describe('name similarity', () => {
  it('matches a counterparty name against the contact however it is written', () => {
    expect(nameSimilarity({ counterpartyName: 'ACME CORP' }, 'Acme Corporation Inc')).toBe(1);
    expect(nameSimilarity({ counterpartyName: 'SMITH AND SONS PLUMBING' }, 'Smith & Sons Plumbing LLC')).toBe(1);
    expect(nameSimilarity({ counterpartyName: 'ACME' }, 'Acme Roofing')).toBeLessThan(0.8);
  });

  it('finds the contact inside a free-text description', () => {
    const similarity = nameSimilarity({ description: 'ACH CREDIT ACME CORP INV 2001' }, 'Acme Corporation');
    expect(similarity).toBeGreaterThanOrEqual(0.8);
    expect(nameSimilarity({ description: 'CARD PURCHASE STAPLES 0123' }, 'Acme Corporation')).toBe(0);
  });

  it('matches word beginnings of four letters or more', () => {
    expect(nameSimilarity({ counterpartyName: 'PLUMB RITE' }, 'Plumbing Rite')).toBe(1);
    expect(nameSimilarity({ counterpartyName: 'AB' }, 'Abacus')).toBe(0);
  });

  it('turns a similarity into confidence', () => {
    expect(nameConfidence(1)).toEqual({ confidence: 0.3, reason: 'name matches' });
    expect(nameConfidence(0.6)?.confidence).toBe(0.15);
    expect(nameConfidence(0.2)).toBeNull();
  });
});

describe('dates', () => {
  it('counts whole days', () => {
    expect(daysApart('2026-01-01', new Date('2026-01-11T23:00:00Z'))).toBe(10);
  });
});
