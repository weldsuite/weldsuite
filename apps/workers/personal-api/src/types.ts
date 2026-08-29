export interface Env {
  /** Neon connection string for master DB (personal_accounts, registry). */
  DATABASE_URL_MASTER: string;
  /** Neon connection string for shared personal DB (mail tables). */
  DATABASE_URL_PERSONAL: string;
  CLERK_SECRET_KEY: string;
  CLERK_JWT_KEY?: string;
  ENVIRONMENT: string;
}

export type PersonalAccountSummary = {
  id: string;
  clerkUserId: string;
  displayName: string | null;
};

export type Variables = {
  userId: string;
  sessionId: string;
  personalAccountId: string | null;
  personalAccount: PersonalAccountSummary | null;
};
