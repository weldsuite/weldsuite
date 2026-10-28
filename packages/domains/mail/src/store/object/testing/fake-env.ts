/**
 * Test doubles for the env bindings `ObjectMailboxStore`/`ObjectWorkspaceMailStore`
 * need: a `MAILBOX_STORE` namespace backed by `./fake-stub`'s fakes (one per
 * mailbox, created lazily and cached by name — just like a real
 * `DurableObjectNamespace` hands back the same object for the same id within
 * an isolate), and a `MAIL_INDEX` namespace for the counterparty fan-in's
 * `MailIndex` lookups.
 *
 * Style follows this package's other test fakes (`d1.ts`, `r2.ts`): build a
 * small, honestly-typed implementation, then cast it to the real ambient
 * binding type at the boundary.
 */

import type { MailIndexBindingEnv } from '../../../mail-index/client';
import type { MailIndexStatus } from '../../../mail-index/types';
import type { MailboxRef } from '../../types';
import { createFakeMailboxStub, type FakeMailboxStub } from './fake-stub';
import type { MailboxStoreNamespace } from '../stub';

function parseMailboxKey(name: string): MailboxRef {
  const parts = name.split(':');
  if (parts.length !== 3 || parts[0] !== 'mbx') {
    throw new Error(`createFakeMailboxNamespace: cannot parse mailbox key "${name}"`);
  }
  return { workspaceId: parts[1] as string, accountId: parts[2] as string };
}

export interface FakeMailboxNamespace {
  namespace: MailboxStoreNamespace;
  /** Every stub created so far, keyed by `mbx:<workspaceId>:<accountId>` — for assertions against a specific mailbox's backing state. */
  stubs: Map<string, FakeMailboxStub>;
}

/**
 * A `MailboxStoreNamespace` that lazily creates (and then reuses) one
 * `FakeMailboxStub` per distinct name it's asked to `get()` — mirroring a
 * real `DurableObjectNamespace`'s "same id, same instance" behaviour within
 * one isolate. `makeStub` is overridable so a test can pre-seed specific
 * mailboxes before `ObjectMailboxStore` ever touches them.
 */
export function createFakeMailboxNamespace(
  makeStub: (ref: MailboxRef) => FakeMailboxStub = createFakeMailboxStub,
): FakeMailboxNamespace {
  const stubs = new Map<string, FakeMailboxStub>();
  const namespace: MailboxStoreNamespace = {
    jurisdiction(jurisdiction) {
      if (jurisdiction !== 'eu') {
        throw new Error(`createFakeMailboxNamespace: unexpected jurisdiction "${jurisdiction}" (mailboxes are always EU, decision 1)`);
      }
      return {
        idFromName: (name: string) => name,
        get: (id: unknown) => {
          const name = id as string;
          let stub = stubs.get(name);
          if (!stub) {
            stub = makeStub(parseMailboxKey(name));
            stubs.set(name, stub);
          }
          return stub;
        },
      };
    },
  };
  return { namespace, stubs };
}

export interface FakeMailIndexOptions {
  /** `MailIndex.status(workspaceId).seeded` — default `true` (the common case: counterparty routing should trust the index). */
  seeded?: boolean;
  /** Lower-cased address → mailbox (account) ids, as `MailIndex.mailboxesForAddress` would return them. */
  addressToMailboxes?: Map<string, string[]>;
}

/**
 * A `MAIL_INDEX` env fragment whose `mailboxesForAddress`/`status` answer
 * from an in-memory map instead of a real `MailIndex` Durable Object — enough
 * for `ObjectWorkspaceMailStore.messagesByCounterparty`'s tests.
 */
export function createFakeMailIndexEnv(opts: FakeMailIndexOptions = {}): Pick<MailIndexBindingEnv, 'MAIL_INDEX'> {
  const seeded = opts.seeded ?? true;
  const addressToMailboxes = opts.addressToMailboxes ?? new Map<string, string[]>();
  const status: MailIndexStatus = {
    seeded,
    seeding: { state: seeded ? 'done' : 'idle', source: null, cursor: null, startedAt: null, copied: 0, attempts: 0, lastError: null },
    correspondentsCount: 0,
    addressIndexCount: 0,
    appliedMessagesCount: 0,
    databaseSize: 0,
  };
  const stub = {
    status: async () => status,
    mailboxesForAddress: async (_workspaceId: string, address: string) => addressToMailboxes.get(address.trim().toLowerCase()) ?? [],
  };
  const namespace = {
    jurisdiction: () => ({ idFromName: (name: string) => name, get: () => stub }),
  };
  return { MAIL_INDEX: namespace as unknown as MailIndexBindingEnv['MAIL_INDEX'] };
}

/** A `MAIL_INDEX` env fragment that always throws — exercises the "index unavailable" fallback path. */
export function createFailingMailIndexEnv(message = 'MailIndex unreachable'): Pick<MailIndexBindingEnv, 'MAIL_INDEX'> {
  const stub = {
    status: async () => {
      throw new Error(message);
    },
    mailboxesForAddress: async () => {
      throw new Error(message);
    },
  };
  const namespace = {
    jurisdiction: () => ({ idFromName: (name: string) => name, get: () => stub }),
  };
  return { MAIL_INDEX: namespace as unknown as MailIndexBindingEnv['MAIL_INDEX'] };
}
