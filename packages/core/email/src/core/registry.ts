/**
 * Provider registry. Each consuming worker calls one of the
 * `register*Provider` functions during bootstrap; nothing is registered
 * implicitly at import time so that a worker can opt out of providers it
 * doesn't have bindings for.
 */

import type {
  IEmailSendProvider,
  IEmailReceiveProvider,
  IMailDomainProvider,
  IMailAccountProvider,
} from './types';

type SendFactory = () => IEmailSendProvider;
type ReceiveFactory = () => IEmailReceiveProvider<unknown>;
type DomainFactory = () => IMailDomainProvider;
type AccountFactory = () => IMailAccountProvider;

const sendProviders = new Map<string, SendFactory>();
const receiveProviders = new Map<string, ReceiveFactory>();
const domainProviders = new Map<string, DomainFactory>();
const accountProviders = new Map<string, AccountFactory>();

let defaultSend: string | null = null;
let defaultReceive: string | null = null;
let defaultDomain: string | null = null;
let defaultAccount: string | null = null;

// ---- registration ----------------------------------------------------------

export function registerSendProvider(name: string, factory: SendFactory): void {
  sendProviders.set(name, factory);
}
export function registerReceiveProvider(name: string, factory: ReceiveFactory): void {
  receiveProviders.set(name, factory);
}
export function registerDomainProvider(name: string, factory: DomainFactory): void {
  domainProviders.set(name, factory);
}
export function registerAccountProvider(name: string, factory: AccountFactory): void {
  accountProviders.set(name, factory);
}

export function setDefaultSendProvider(name: string): void {
  defaultSend = name;
}
export function setDefaultReceiveProvider(name: string): void {
  defaultReceive = name;
}
export function setDefaultDomainProvider(name: string): void {
  defaultDomain = name;
}
export function setDefaultAccountProvider(name: string): void {
  defaultAccount = name;
}

// ---- lookup ----------------------------------------------------------------

export function getSendProvider(name?: string): IEmailSendProvider {
  const key = name ?? defaultSend;
  if (!key) throw new Error('No default send provider configured. Call setDefaultSendProvider().');
  const factory = sendProviders.get(key);
  if (!factory) {
    throw new Error(`Unknown send provider "${key}". Registered: ${[...sendProviders.keys()].join(', ') || '(none)'}`);
  }
  return factory();
}

export function getReceiveProvider<TInput = unknown>(name?: string): IEmailReceiveProvider<TInput> {
  const key = name ?? defaultReceive;
  if (!key) throw new Error('No default receive provider configured. Call setDefaultReceiveProvider().');
  const factory = receiveProviders.get(key);
  if (!factory) {
    throw new Error(`Unknown receive provider "${key}". Registered: ${[...receiveProviders.keys()].join(', ') || '(none)'}`);
  }
  return factory() as IEmailReceiveProvider<TInput>;
}

export function getDomainProvider(name?: string): IMailDomainProvider {
  const key = name ?? defaultDomain;
  if (!key) throw new Error('No default domain provider configured. Call setDefaultDomainProvider().');
  const factory = domainProviders.get(key);
  if (!factory) {
    throw new Error(`Unknown domain provider "${key}". Registered: ${[...domainProviders.keys()].join(', ') || '(none)'}`);
  }
  return factory();
}

export function getAccountProvider(name?: string): IMailAccountProvider {
  const key = name ?? defaultAccount;
  if (!key) throw new Error('No default account provider configured. Call setDefaultAccountProvider().');
  const factory = accountProviders.get(key);
  if (!factory) {
    throw new Error(`Unknown account provider "${key}". Registered: ${[...accountProviders.keys()].join(', ') || '(none)'}`);
  }
  return factory();
}

// ---- introspection ---------------------------------------------------------

export function listSendProviders(): string[] {
  return [...sendProviders.keys()];
}
export function listReceiveProviders(): string[] {
  return [...receiveProviders.keys()];
}
export function listDomainProviders(): string[] {
  return [...domainProviders.keys()];
}
export function listAccountProviders(): string[] {
  return [...accountProviders.keys()];
}

export function hasSendProvider(name: string): boolean {
  return sendProviders.has(name);
}
export function hasReceiveProvider(name: string): boolean {
  return receiveProviders.has(name);
}
export function hasDomainProvider(name: string): boolean {
  return domainProviders.has(name);
}
export function hasAccountProvider(name: string): boolean {
  return accountProviders.has(name);
}

/**
 * Test helper — wipes every registration. Production code should never call
 * this; it exists so unit tests can start from a clean slate.
 */
export function __resetRegistryForTests(): void {
  sendProviders.clear();
  receiveProviders.clear();
  domainProviders.clear();
  accountProviders.clear();
  defaultSend = null;
  defaultReceive = null;
  defaultDomain = null;
  defaultAccount = null;
}
