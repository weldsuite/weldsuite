import { z } from 'zod';

// ============================================================================
// person_companies — time-bounded employment / affiliation between a Person
// and a Company. Replaces the legacy contact_customers + contact_suppliers
// junctions. The customer/supplier distinction is a property of the Company,
// not the relationship — this junction only captures the functional role
// (billing, technical, decision_maker) and whether it's the primary
// employment.
// ============================================================================

export const createPersonCompanySchema = z.object({
  personId: z.string().min(1),
  companyId: z.string().min(1),
  role: z.string().max(50).optional(),
  isPrimary: z.boolean().optional().default(false),
  startedAt: z.string().datetime().optional(),
  endedAt: z.string().datetime().optional(),
});

export const updatePersonCompanySchema = createPersonCompanySchema
  .pick({ role: true, isPrimary: true, startedAt: true, endedAt: true })
  .partial();

export const listPersonCompaniesQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).default(100),
  personId: z.string().optional(),
  companyId: z.string().optional(),
  /** Include rows with `endedAt` set (historical employments). Default false. */
  includeEnded: z.coerce.boolean().optional(),
});

export type CreatePersonCompanyInput = z.infer<typeof createPersonCompanySchema>;
export type UpdatePersonCompanyInput = z.infer<typeof updatePersonCompanySchema>;
export type ListPersonCompaniesQuery = z.infer<typeof listPersonCompaniesQuery>;

export interface PersonCompany {
  id: string;
  createdAt: string;
  updatedAt: string;
  personId: string;
  companyId: string;
  role?: string | null;
  isPrimary: boolean;
  startedAt?: string | null;
  endedAt?: string | null;

  /**
   * Hydrated person snapshot — present on listings returned by
   * `GET /weldcrm/companies/:id/people`. Lets the UI render a name + avatar
   * without an N+1 fetch. Null if the joined row has been soft-deleted.
   */
  person?: {
    id: string;
    displayName: string;
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
    avatarUrl?: string | null;
  } | null;

  /**
   * Hydrated company snapshot — present on listings returned by
   * `GET /weldcrm/people/:id/companies`. Same purpose as `person` above.
   */
  company?: {
    id: string;
    displayName: string;
    name?: string | null;
    industry?: string | null;
    avatarUrl?: string | null;
  } | null;
}
