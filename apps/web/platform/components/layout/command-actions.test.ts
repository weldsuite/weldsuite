import { describe, expect, it } from 'vitest';
import {
  CREATE_COMPANY_SYNONYMS,
  CREATE_PERSON_SYNONYMS,
  commandActionKeywords,
  filterCommandActions,
  type CommandActionDefinition,
} from './command-actions';

const company: CommandActionDefinition = {
  id: 'create-company',
  keywords: commandActionKeywords('Create company', CREATE_COMPANY_SYNONYMS),
};
const person: CommandActionDefinition = {
  id: 'create-person',
  keywords: commandActionKeywords('Create person', CREATE_PERSON_SYNONYMS),
};
const actions = [company, person];

describe('filterCommandActions', () => {
  it('shows every action when the palette query is empty', () => {
    expect(filterCommandActions('', actions).map((a) => a.id)).toEqual([
      'create-company',
      'create-person',
    ]);
    expect(filterCommandActions('   ', actions)).toHaveLength(2);
  });

  it('leaves a single character to search', () => {
    expect(filterCommandActions('c', actions)).toEqual([]);
  });

  it('matches create company from a prefix of the label', () => {
    expect(filterCommandActions('create co', actions).map((a) => a.id)).toEqual(['create-company']);
    expect(filterCommandActions('company', actions).map((a) => a.id)).toEqual(['create-company']);
  });

  it('matches create person, including the Dutch label', () => {
    const dutch = {
      id: 'create-person',
      keywords: commandActionKeywords('Persoon toevoegen', CREATE_PERSON_SYNONYMS),
    };
    expect(filterCommandActions('persoon', [dutch, company]).map((a) => a.id)).toEqual([
      'create-person',
    ]);
    expect(filterCommandActions('create person', actions).map((a) => a.id)).toEqual([
      'create-person',
    ]);
  });

  it('does not treat a record search as an action', () => {
    expect(filterCommandActions('acme', actions)).toEqual([]);
    expect(filterCommandActions('settings', actions)).toEqual([]);
  });

  it('matches the other locale via synonyms', () => {
    expect(filterCommandActions('bedrijf', actions).map((a) => a.id)).toEqual(['create-company']);
    expect(filterCommandActions('aanmaken', actions).map((a) => a.id)).toEqual([
      'create-company',
      'create-person',
    ]);
  });
});
