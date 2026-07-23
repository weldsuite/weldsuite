/**
 * CRM sample data seeder.
 *
 * Seeds: companies, people (linked via person_companies), pipeline + stages,
 * leads, opportunities. The legacy `parties` + `contacts` tables are not
 * touched — those concepts are deprecated in the companies/people refactor.
 */

import { companies } from '@weldsuite/db/schema/companies';
import { people } from '@weldsuite/db/schema/people';
import { personCompanies } from '@weldsuite/db/schema/person-companies';
import { crmPipelines } from '@weldsuite/db/schema/crm-pipelines';
import { crmPipelineStages } from '@weldsuite/db/schema/crm-pipeline-stages';
import { crmLeads } from '@weldsuite/db/schema/crm-leads';
import { crmOpportunities } from '@weldsuite/db/schema/crm-opportunities';
import type { DrizzleDb, SeedContext } from './types';

export async function seedCrmData(db: DrizzleDb, ctx: SeedContext): Promise<void> {
  // Idempotency: skip if companies already exist.
  const existing = await db.select({ id: companies.id }).from(companies).limit(1);
  if (existing.length > 0) {
    console.log('[Seed:CRM] Companies already exist, skipping');
    return;
  }

  const now = new Date();
  const { generateId, userId } = ctx;

  // ── Companies ──────────────────────────────────────────────────────────
  const acmeId = generateId('company');
  const techstartId = generateId('company');
  const greenvalleyId = generateId('company');

  await db.insert(companies).values([
    {
      id: acmeId,
      name: 'Acme Corporation',
      displayName: 'Acme Corporation',
      email: 'info@acmecorp.com',
      phone: '+31 20 123 4567',
      website: 'https://acmecorp.com',
      industry: 'Technology',
      employeeCount: '50-200',
      segment: 'enterprise',
      status: 'active',
      rating: 'hot',
      source: 'website',
      ownerId: userId,
      lifecycleStage: 'customer',
    },
    {
      id: techstartId,
      name: 'TechStart Inc.',
      displayName: 'TechStart Inc.',
      email: 'hello@techstart.io',
      phone: '+31 10 987 6543',
      website: 'https://techstart.io',
      industry: 'Software',
      employeeCount: '10-50',
      segment: 'startup',
      status: 'prospect',
      rating: 'warm',
      source: 'referral',
      ownerId: userId,
      lifecycleStage: 'opportunity',
    },
    {
      id: greenvalleyId,
      name: 'Green Valley Design',
      displayName: 'Green Valley Design',
      email: 'contact@greenvalley.nl',
      phone: '+31 30 456 7890',
      website: 'https://greenvalleydesign.nl',
      industry: 'Design',
      employeeCount: '1-10',
      segment: 'small_business',
      status: 'active',
      rating: 'warm',
      source: 'social_media',
      ownerId: userId,
      lifecycleStage: 'customer',
    },
  ]);

  // ── People (linked via person_companies junction) ─────────────────────
  const johnId = generateId('person');
  const emilyId = generateId('person');
  const lisaId = generateId('person');

  await db.insert(people).values([
    {
      id: johnId,
      firstName: 'John',
      lastName: 'Smith',
      fullName: 'John Smith',
      displayName: 'John Smith',
      email: 'john.smith@acmecorp.com',
      directPhone: '+31 20 123 4568',
      title: 'Chief Technology Officer',
      department: 'Engineering',
      role: 'decision_maker',
      isDecisionMaker: true,
      status: 'active',
      preferredContactMethod: 'email',
    },
    {
      id: emilyId,
      firstName: 'Emily',
      lastName: 'Chen',
      fullName: 'Emily Chen',
      displayName: 'Emily Chen',
      email: 'emily.chen@techstart.io',
      directPhone: '+31 10 987 6544',
      title: 'Head of Operations',
      department: 'Operations',
      role: 'champion',
      status: 'active',
      preferredContactMethod: 'email',
    },
    {
      id: lisaId,
      firstName: 'Lisa',
      lastName: 'Martinez',
      fullName: 'Lisa Martinez',
      displayName: 'Lisa Martinez',
      email: 'lisa@greenvalley.nl',
      mobilePhone: '+31 6 1234 5678',
      title: 'Founder & Creative Director',
      department: 'Management',
      role: 'decision_maker',
      isDecisionMaker: true,
      status: 'active',
      preferredContactMethod: 'phone',
    },
  ]);

  await db.insert(personCompanies).values([
    {
      id: generateId('pc'),
      personId: johnId,
      companyId: acmeId,
      isPrimary: true,
      role: 'decision_maker',
      startedAt: now,
    },
    {
      id: generateId('pc'),
      personId: emilyId,
      companyId: techstartId,
      isPrimary: true,
      role: 'champion',
      startedAt: now,
    },
    {
      id: generateId('pc'),
      personId: lisaId,
      companyId: greenvalleyId,
      isPrimary: true,
      role: 'decision_maker',
      startedAt: now,
    },
  ]);

  // ── Pipeline & Stages ──────────────────────────────────────────────────
  const pipelineId = generateId('pipe');
  await db.insert(crmPipelines).values({
    id: pipelineId,
    name: 'Sales Pipeline',
    description: 'Default sales pipeline for tracking deals from prospecting to close',
    icon: 'TrendingUp',
    color: 'bg-blue-500',
    isDefault: true,
    settings: { showProbability: true, defaultCurrency: 'EUR' },
  });

  const stageProspecting = generateId('stg');
  const stageQualification = generateId('stg');
  const stageProposal = generateId('stg');
  const stageNegotiation = generateId('stg');
  const stageClosedWon = generateId('stg');

  await db.insert(crmPipelineStages).values([
    {
      id: stageProspecting,
      name: 'Prospecting',
      position: 0,
      probability: 10,
      color: 'bg-slate-500',
      pipeline: pipelineId,
    },
    {
      id: stageQualification,
      name: 'Qualification',
      position: 1,
      probability: 25,
      color: 'bg-blue-500',
      pipeline: pipelineId,
    },
    {
      id: stageProposal,
      name: 'Proposal',
      position: 2,
      probability: 50,
      color: 'bg-amber-500',
      pipeline: pipelineId,
      isDefault: true,
    },
    {
      id: stageNegotiation,
      name: 'Negotiation',
      position: 3,
      probability: 75,
      color: 'bg-orange-500',
      pipeline: pipelineId,
    },
    {
      id: stageClosedWon,
      name: 'Closed Won',
      position: 4,
      probability: 100,
      color: 'bg-green-500',
      pipeline: pipelineId,
      isWon: true,
    },
  ]);

  // ── Leads ──────────────────────────────────────────────────────────────
  await db.insert(crmLeads).values([
    {
      id: generateId('lead'),
      firstName: 'David',
      lastName: 'Park',
      fullName: 'David Park',
      companyName: 'Horizon Labs',
      title: 'VP of Engineering',
      email: 'david.park@horizonlabs.com',
      phone: '+31 20 555 0101',
      source: 'website',
      status: 'new',
      rating: 'hot',
      score: 85,
      ownerId: userId,
      need: 'Looking for an all-in-one business platform to replace multiple SaaS tools.',
    },
    {
      id: generateId('lead'),
      firstName: 'Maria',
      lastName: 'Garcia',
      fullName: 'Maria Garcia',
      companyName: 'Atlas Enterprises',
      title: 'Operations Manager',
      email: 'maria.garcia@atlasenterprises.com',
      phone: '+31 10 555 0202',
      source: 'referral',
      status: 'contacted',
      rating: 'warm',
      score: 60,
      ownerId: userId,
      numberOfTouches: 2,
      lastActivityAt: now,
      need: 'Needs a CRM with helpdesk integration for their growing team.',
    },
    {
      id: generateId('lead'),
      firstName: 'Alex',
      lastName: 'Johnson',
      fullName: 'Alex Johnson',
      companyName: 'BluePeak Consulting',
      title: 'Managing Director',
      email: 'alex@bluepeak.io',
      source: 'social_media',
      channel: 'LinkedIn',
      status: 'qualified',
      rating: 'warm',
      score: 70,
      isQualified: true,
      qualifiedAt: now,
      ownerId: userId,
      need: 'Interested in project management and CRM for client delivery tracking.',
    },
  ]);

  // ── Opportunities ──────────────────────────────────────────────────────
  // The legacy `customerId` column is still NOT NULL on the schema (Phase 7
  // cleanup will drop it). For seed purposes we point it at the new company
  // id — the column is going away regardless of FK validity.
  const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const sixtyDaysFromNow = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);

  await db.insert(crmOpportunities).values([
    {
      id: generateId('opp'),
      name: 'Acme Corp Annual Contract',
      description: 'Enterprise license for the full WeldSuite platform with premium support.',
      customerId: acmeId,
      customerName: 'Acme Corporation',
      amount: '25000',
      currency: 'EUR',
      stage: 'proposal',
      stageId: stageProposal,
      probability: 50,
      pipeline: pipelineId,
      closeDate: thirtyDaysFromNow,
      ownerId: userId,
      status: 'open',
      type: 'new_business',
      forecastCategory: 'best_case',
      nextStep: 'Send revised proposal with volume discount',
      nextStepDate: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000),
    },
    {
      id: generateId('opp'),
      name: 'TechStart Onboarding Package',
      description: 'Starter package with CRM and Helpdesk modules for the growing team.',
      customerId: techstartId,
      customerName: 'TechStart Inc.',
      amount: '5000',
      currency: 'EUR',
      stage: 'qualification',
      stageId: stageQualification,
      probability: 25,
      pipeline: pipelineId,
      closeDate: sixtyDaysFromNow,
      ownerId: userId,
      status: 'open',
      type: 'new_business',
      forecastCategory: 'pipeline',
      nextStep: 'Schedule product demo with their team',
      nextStepDate: new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000),
    },
  ]);

  console.log('[Seed:CRM] Seeded 3 companies, 3 people, 1 pipeline with 5 stages, 3 leads, 2 opportunities');
}
