/**
 * Deterministic mock data for the WeldCRM flows.
 *
 * Shaped to mirror the real CRM list/detail screens (people, leads, pipeline)
 * but with plain local types — we intentionally do NOT import platform or
 * `@weldsuite/db` types here, to keep the storybook isolated from the app's
 * provider/router coupling.
 *
 * `faker.seed(...)` is called once at module load so the generated records are
 * stable across reloads (a flow demo should look the same every time).
 */
import { faker } from '@faker-js/faker';

faker.seed(20260606);

export type PersonStatus = 'active' | 'lead' | 'customer' | 'inactive';

export interface Person {
  id: string;
  firstName: string;
  lastName: string;
  name: string;
  initials: string;
  email: string;
  phone: string;
  jobTitle: string;
  company: string;
  status: PersonStatus;
  tags: string[];
  city: string;
  createdAt: string;
}

export type LeadStage = 'new' | 'contacted' | 'qualified' | 'unqualified';

export interface Lead {
  id: string;
  firstName: string;
  lastName: string;
  name: string;
  initials: string;
  email: string;
  companyName: string;
  stage: LeadStage;
  source: string;
  estimatedValue: number;
  createdAt: string;
}

export interface Activity {
  id: string;
  type: 'note' | 'email' | 'call' | 'meeting';
  title: string;
  body: string;
  author: string;
  timestamp: string;
}

const PERSON_TAGS = ['VIP', 'Newsletter', 'Trial', 'Champion', 'Decision maker', 'Procurement'];
const LEAD_SOURCES = ['Website form', 'Referral', 'Trade show', 'Cold outreach', 'LinkedIn'];

function initialsOf(first: string, last: string): string {
  return `${first[0] ?? ''}${last[0] ?? ''}`.toUpperCase();
}

function makePerson(status: PersonStatus): Person {
  const firstName = faker.person.firstName();
  const lastName = faker.person.lastName();
  const company = faker.company.name();
  return {
    id: `per_${faker.string.alphanumeric(10)}`,
    firstName,
    lastName,
    name: `${firstName} ${lastName}`,
    initials: initialsOf(firstName, lastName),
    email: faker.internet.email({ firstName, lastName }).toLowerCase(),
    phone: faker.phone.number(),
    jobTitle: faker.person.jobTitle(),
    company,
    status,
    tags: faker.helpers.arrayElements(PERSON_TAGS, { min: 0, max: 2 }),
    city: faker.location.city(),
    createdAt: faker.date.recent({ days: 90 }).toISOString(),
  };
}

function makeLead(stage: LeadStage): Lead {
  const firstName = faker.person.firstName();
  const lastName = faker.person.lastName();
  return {
    id: `lead_${faker.string.alphanumeric(10)}`,
    firstName,
    lastName,
    name: `${firstName} ${lastName}`,
    initials: initialsOf(firstName, lastName),
    email: faker.internet.email({ firstName, lastName }).toLowerCase(),
    companyName: faker.company.name(),
    stage,
    source: faker.helpers.arrayElement(LEAD_SOURCES),
    estimatedValue: faker.number.int({ min: 1, max: 40 }) * 500,
    createdAt: faker.date.recent({ days: 30 }).toISOString(),
  };
}

/** A realistic set of contacts for the people list. */
export const people: Person[] = [
  ...Array.from({ length: 6 }, () => makePerson('customer')),
  ...Array.from({ length: 5 }, () => makePerson('active')),
  ...Array.from({ length: 3 }, () => makePerson('lead')),
  ...Array.from({ length: 2 }, () => makePerson('inactive')),
];

/** Existing leads (used by the "capture a lead" flow). */
export const leads: Lead[] = [
  makeLead('contacted'),
  makeLead('qualified'),
  makeLead('new'),
  makeLead('contacted'),
];

/** A fresh lead the user "captures" in the flow — deterministic, not random. */
export const newLead: Lead = {
  id: 'lead_new000001',
  firstName: 'Mara',
  lastName: 'Devlin',
  name: 'Mara Devlin',
  initials: 'MD',
  email: 'mara.devlin@northwind.example',
  companyName: 'Northwind Fabrication',
  stage: 'new',
  source: 'Website form',
  estimatedValue: 7500,
  createdAt: faker.date.recent({ days: 1 }).toISOString(),
};

/** Sample activity timeline for a contact's detail view. */
export const contactActivity: Activity[] = [
  {
    id: 'act_1',
    type: 'email',
    title: 'Sent quote follow-up',
    body: 'Shared the updated pricing sheet and proposed a call next week.',
    author: 'You',
    timestamp: faker.date.recent({ days: 2 }).toISOString(),
  },
  {
    id: 'act_2',
    type: 'call',
    title: 'Discovery call (18 min)',
    body: 'Walked through requirements. Budget confirmed for Q3.',
    author: 'You',
    timestamp: faker.date.recent({ days: 6 }).toISOString(),
  },
  {
    id: 'act_3',
    type: 'note',
    title: 'Added to nurture sequence',
    body: 'Tagged as Champion. Prefers email over phone.',
    author: 'Priya N.',
    timestamp: faker.date.recent({ days: 12 }).toISOString(),
  },
];

export const STATUS_LABELS: Record<PersonStatus, string> = {
  active: 'Active',
  lead: 'Lead',
  customer: 'Customer',
  inactive: 'Inactive',
};

export const LEAD_STAGE_LABELS: Record<LeadStage, string> = {
  new: 'New',
  contacted: 'Contacted',
  qualified: 'Qualified',
  unqualified: 'Unqualified',
};
