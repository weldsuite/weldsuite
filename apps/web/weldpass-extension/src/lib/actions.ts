/**
 * What the popup's buttons do, without React or `chrome.*` in the way: the page
 * is reached through a `PagePort` and the API through the typed client, so the
 * safety rules below are unit-tested with fakes.
 *
 * Secrets are handled as locals only. A revealed password lives for the length
 * of one function call here — it is passed to the page or the clipboard and
 * then dropped. Nothing in this file stores, caches or logs one.
 */

import type {
  WeldPassItem,
  WeldPassPasswordsApi,
} from '@weldsuite/app-api-client/domains/weldpass-passwords';
import type { PageCommand, PageResult } from '../page/page-agent';
import { evaluateFill, pageContext, type FillBlock, type PageBlock } from './fill-policy';

/** The active tab, as far as the actions need it. Implemented over `chrome.*` in chrome-page.ts. */
export interface PagePort {
  /** The tab's current URL, read now — not the one the popup saw when it opened. */
  currentUrl(tabId: number): Promise<string | null>;
  run(tabId: number, command: PageCommand): Promise<PageResult>;
}

export type FillFailure =
  | FillBlock
  | 'not-a-login'
  | 'no-fields'
  | 'page-changed'
  | 'injection-failed';

export type FillOutcome =
  | { ok: true; username: boolean; password: boolean }
  | { ok: false; reason: FillFailure };

async function runOnPage(
  page: PagePort,
  tabId: number,
  command: PageCommand,
): Promise<PageResult | null> {
  try {
    return await page.run(tabId, command);
  } catch {
    // The browser refuses some pages outright (the Web Store, PDF viewer, a tab
    // that navigated away and took the activeTab grant with it).
    return null;
  }
}

/**
 * Fill a saved login into the tab.
 *
 * The host and protocol rules are enforced here, at fill time, against the
 * tab's URL as it is now: before the password is asked for, again once it has
 * arrived (the reveal is a network call, and the tab can navigate meanwhile),
 * and a third time inside the page, which refuses any origin but the one
 * validated here.
 *
 * The password is only revealed when the page actually shows a password field.
 * On the first step of a two-step login the username from the list is enough.
 */
export async function fillLogin(
  api: Pick<WeldPassPasswordsApi, 'revealItem'>,
  page: PagePort,
  item: WeldPassItem,
  tabId: number,
): Promise<FillOutcome> {
  if (item.type !== 'login') return { ok: false, reason: 'not-a-login' };

  const verdict = evaluateFill(item, await page.currentUrl(tabId));
  if (!verdict.ok) return verdict;
  const { origin } = verdict;

  const probe = await runOnPage(page, tabId, { kind: 'probe', expectedOrigin: origin });
  if (!probe) return { ok: false, reason: 'injection-failed' };
  if (probe.status === 'origin-mismatch') return { ok: false, reason: 'page-changed' };
  if (probe.status !== 'probed' || (!probe.hasPassword && !probe.hasUsername)) {
    return { ok: false, reason: 'no-fields' };
  }

  let username = item.subtitle ?? '';
  let password: string | null = null;

  if (probe.hasPassword) {
    const revealed = (await api.revealItem(item.vaultId, item.id)).data;
    if (revealed.type !== 'login' || !('password' in revealed.fields)) {
      return { ok: false, reason: 'not-a-login' };
    }
    // Judge the item as the server holds it now, against the tab as it is now.
    const recheck = evaluateFill(revealed, await page.currentUrl(tabId));
    if (!recheck.ok) return recheck;
    if (recheck.origin !== origin) return { ok: false, reason: 'page-changed' };

    username = revealed.fields.username;
    password = revealed.fields.password;
  } else if (!username) {
    return { ok: false, reason: 'no-fields' };
  }

  const result = await runOnPage(page, tabId, {
    kind: 'fill-login',
    expectedOrigin: origin,
    username,
    password,
  });
  if (!result) return { ok: false, reason: 'injection-failed' };
  if (result.status === 'origin-mismatch') return { ok: false, reason: 'page-changed' };
  if (result.status !== 'filled') return { ok: false, reason: 'no-fields' };
  return { ok: true, username: result.username, password: result.password };
}

/** The item's password, fetched for this one use. Null if the item has none. */
export async function revealPassword(
  api: Pick<WeldPassPasswordsApi, 'revealItem'>,
  item: WeldPassItem,
): Promise<string | null> {
  const { fields } = (await api.revealItem(item.vaultId, item.id)).data;
  return 'password' in fields && fields.password ? fields.password : null;
}

export type PageFailure = PageBlock | 'no-fields' | 'page-changed' | 'injection-failed';

export type ReadOutcome =
  | { ok: true; username: string; password: string; hasPasswordField: boolean }
  | { ok: false; reason: PageFailure };

/**
 * What is typed in the tab's login form, for the "Save login" form. The values
 * come from a web page: treat them as untrusted text, never as markup.
 */
export async function readLoginFromPage(page: PagePort, tabId: number): Promise<ReadOutcome> {
  const context = pageContext(await page.currentUrl(tabId));
  if (!context.ok) return context;

  const result = await runOnPage(page, tabId, {
    kind: 'read-login',
    expectedOrigin: context.origin,
  });
  if (!result) return { ok: false, reason: 'injection-failed' };
  if (result.status === 'origin-mismatch') return { ok: false, reason: 'page-changed' };
  if (result.status !== 'read') return { ok: false, reason: 'no-fields' };
  return {
    ok: true,
    username: result.username,
    password: result.password,
    hasPasswordField: result.hasPasswordField,
  };
}

export type NewPasswordOutcome = { ok: true; fields: number } | { ok: false; reason: PageFailure };

/** Put a generated password into the tab's new-password field(s). */
export async function fillNewPassword(
  page: PagePort,
  tabId: number,
  password: string,
): Promise<NewPasswordOutcome> {
  const context = pageContext(await page.currentUrl(tabId));
  if (!context.ok) return context;

  const result = await runOnPage(page, tabId, {
    kind: 'fill-new-password',
    expectedOrigin: context.origin,
    password,
  });
  if (!result) return { ok: false, reason: 'injection-failed' };
  if (result.status === 'origin-mismatch') return { ok: false, reason: 'page-changed' };
  if (result.status !== 'filled') return { ok: false, reason: 'no-fields' };
  return { ok: true, fields: result.passwordFields };
}
