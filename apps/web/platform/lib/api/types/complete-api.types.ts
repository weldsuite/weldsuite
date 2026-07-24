/**
 * WeldSuite Complete API Type Definitions
 *
 * Historically this file held a comprehensive draft type system for every
 * module (commerce, CRM, accounting, WMS, ...). That draft was superseded by
 * the per-module files under `lib/api/types/apps/*.types.ts` and never wired
 * up anywhere; `BaseEntity` below is the only symbol any other file still
 * imports from here.
 */

interface TimestampFields {
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string; // Soft delete support
}

export interface BaseEntity extends TimestampFields {
  id: string;
}
