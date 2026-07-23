export interface StageTemplate {
  name: string;
  color: string;
  probability: number;
  isWon?: boolean;
  isLost?: boolean;
}

export interface PipelineTemplateConfig {
  id: string;
  name: string;
  description: string;
  stages: StageTemplate[];
}

export const PIPELINE_TEMPLATES: Record<string, PipelineTemplateConfig> = {
  'sales-pipeline': {
    id: 'sales-pipeline',
    name: 'Sales Pipeline',
    description: 'Standard sales process from lead to close',
    stages: [
      { name: 'Lead', color: 'bg-gray-500', probability: 10 },
      { name: 'Qualified', color: 'bg-blue-500', probability: 25 },
      { name: 'Proposal', color: 'bg-yellow-500', probability: 50 },
      { name: 'Negotiation', color: 'bg-orange-500', probability: 75 },
      { name: 'Closed Won', color: 'bg-green-500', probability: 100, isWon: true },
      { name: 'Closed Lost', color: 'bg-red-500', probability: 0, isLost: true },
    ],
  },
  'recruiting': {
    id: 'recruiting',
    name: 'Recruiting',
    description: 'Hiring process from application to offer',
    stages: [
      { name: 'Applied', color: 'bg-gray-500', probability: 10 },
      { name: 'Screening', color: 'bg-blue-500', probability: 25 },
      { name: 'Interview', color: 'bg-yellow-500', probability: 50 },
      { name: 'Offer', color: 'bg-orange-500', probability: 80 },
      { name: 'Hired', color: 'bg-green-500', probability: 100, isWon: true },
      { name: 'Rejected', color: 'bg-red-500', probability: 0, isLost: true },
    ],
  },
  'customer-success': {
    id: 'customer-success',
    name: 'Customer Success',
    description: 'Customer lifecycle management',
    stages: [
      { name: 'Onboarding', color: 'bg-blue-500', probability: 25 },
      { name: 'Active', color: 'bg-green-500', probability: 75 },
      { name: 'At Risk', color: 'bg-yellow-500', probability: 40 },
      { name: 'Renewed', color: 'bg-emerald-500', probability: 100, isWon: true },
      { name: 'Churned', color: 'bg-red-500', probability: 0, isLost: true },
    ],
  },
  'employee-onboarding': {
    id: 'employee-onboarding',
    name: 'Employee Onboarding',
    description: 'New hire onboarding process',
    stages: [
      { name: 'Pre-boarding', color: 'bg-gray-500', probability: 20 },
      { name: 'Day 1 Setup', color: 'bg-blue-500', probability: 40 },
      { name: 'Training', color: 'bg-yellow-500', probability: 60 },
      { name: 'Integration', color: 'bg-orange-500', probability: 80 },
      { name: 'Completed', color: 'bg-green-500', probability: 100, isWon: true },
    ],
  },
  'outsourcing': {
    id: 'outsourcing',
    name: 'Outsourcing',
    description: 'Freelancer and contractor pipeline',
    stages: [
      { name: 'Sourcing', color: 'bg-gray-500', probability: 10 },
      { name: 'Evaluation', color: 'bg-blue-500', probability: 30 },
      { name: 'Negotiation', color: 'bg-yellow-500', probability: 50 },
      { name: 'Contract', color: 'bg-orange-500', probability: 75 },
      { name: 'Active', color: 'bg-green-500', probability: 100, isWon: true },
      { name: 'Ended', color: 'bg-red-500', probability: 0, isLost: true },
    ],
  },
  'press-outreach': {
    id: 'press-outreach',
    name: 'Press Outreach',
    description: 'Media and PR campaign management',
    stages: [
      { name: 'Research', color: 'bg-gray-500', probability: 10 },
      { name: 'Outreach', color: 'bg-blue-500', probability: 25 },
      { name: 'Response', color: 'bg-yellow-500', probability: 50 },
      { name: 'Coverage', color: 'bg-orange-500', probability: 75 },
      { name: 'Published', color: 'bg-green-500', probability: 100, isWon: true },
      { name: 'Declined', color: 'bg-red-500', probability: 0, isLost: true },
    ],
  },
  'content-co-creation': {
    id: 'content-co-creation',
    name: 'Content Co-creation',
    description: 'Content pipeline for podcasts, interviews, and collaborations',
    stages: [
      { name: 'Ideation', color: 'bg-gray-500', probability: 10 },
      { name: 'Outreach', color: 'bg-blue-500', probability: 25 },
      { name: 'Planning', color: 'bg-yellow-500', probability: 50 },
      { name: 'Production', color: 'bg-orange-500', probability: 75 },
      { name: 'Published', color: 'bg-green-500', probability: 100, isWon: true },
      { name: 'Cancelled', color: 'bg-red-500', probability: 0, isLost: true },
    ],
  },
  'project-pipeline': {
    id: 'project-pipeline',
    name: 'Project Pipeline',
    description: 'Project opportunity management',
    stages: [
      { name: 'Discovery', color: 'bg-gray-500', probability: 10 },
      { name: 'Planning', color: 'bg-blue-500', probability: 30 },
      { name: 'Proposal', color: 'bg-yellow-500', probability: 50 },
      { name: 'In Progress', color: 'bg-orange-500', probability: 75 },
      { name: 'Delivered', color: 'bg-green-500', probability: 100, isWon: true },
      { name: 'Cancelled', color: 'bg-red-500', probability: 0, isLost: true },
    ],
  },
  'product-launch': {
    id: 'product-launch',
    name: 'Product Launch',
    description: 'Product launch timeline management',
    stages: [
      { name: 'Concept', color: 'bg-gray-500', probability: 10 },
      { name: 'Development', color: 'bg-blue-500', probability: 30 },
      { name: 'Testing', color: 'bg-yellow-500', probability: 50 },
      { name: 'Marketing', color: 'bg-orange-500', probability: 75 },
      { name: 'Launched', color: 'bg-green-500', probability: 100, isWon: true },
      { name: 'Cancelled', color: 'bg-red-500', probability: 0, isLost: true },
    ],
  },
  'partnership-pipeline': {
    id: 'partnership-pipeline',
    name: 'Partnership Pipeline',
    description: 'Strategic partnership management',
    stages: [
      { name: 'Identification', color: 'bg-gray-500', probability: 10 },
      { name: 'Evaluation', color: 'bg-blue-500', probability: 25 },
      { name: 'Negotiation', color: 'bg-yellow-500', probability: 50 },
      { name: 'Agreement', color: 'bg-orange-500', probability: 75 },
      { name: 'Active', color: 'bg-green-500', probability: 100, isWon: true },
      { name: 'Declined', color: 'bg-red-500', probability: 0, isLost: true },
    ],
  },
  'blank': {
    id: 'blank',
    name: 'Blank Pipeline',
    description: 'Start from scratch with basic stages',
    stages: [
      { name: 'Stage 1', color: 'bg-gray-500', probability: 25 },
      { name: 'Stage 2', color: 'bg-blue-500', probability: 50 },
      { name: 'Stage 3', color: 'bg-yellow-500', probability: 75 },
      { name: 'Won', color: 'bg-green-500', probability: 100, isWon: true },
      { name: 'Lost', color: 'bg-red-500', probability: 0, isLost: true },
    ],
  },
};

export function getTemplateStages(templateId: string): StageTemplate[] {
  const template = PIPELINE_TEMPLATES[templateId];
  if (!template) {
    return PIPELINE_TEMPLATES['blank'].stages;
  }
  return template.stages;
}
