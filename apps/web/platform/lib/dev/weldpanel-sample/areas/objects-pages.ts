/**
 * Builds the rrweb node trees behind sample recordings and heatmap snapshots:
 * a small, styled version of each page of the made-up site and product. The
 * elements carry stable `id` attributes, so the heatmap's selectors (`#hero-cta`)
 * and the replay's clicks both land on something that is really there.
 */

import { APP_SCREENS, PAGES } from '../dataset';

/** The node shapes rrweb's `Replayer` rebuilds a page from. */
export type SerializedNode =
  | { type: 0; id: number; childNodes: SerializedNode[] }
  | { type: 1; id: number; name: string; publicId: string; systemId: string }
  | { type: 2; id: number; tagName: string; attributes: Record<string, string>; childNodes: SerializedNode[] }
  | { type: 3; id: number; textContent: string; isStyle?: boolean };

export type PageKind = 'site' | 'app';

/** Where an element sits on a 1280 px wide desktop page, for placing clicks. */
export interface ClickTarget {
  htmlId: string;
  label: string;
  x: number;
  y: number;
  /** How likely a visitor clicks it. */
  weight: number;
}

/** Elements heatmap data can point at on the sample pages (CSS selector, its visible text). */
export const HEATMAP_ELEMENTS: ReadonlyArray<{ selector: string; text: string; paths: string[] }> = [
  { selector: '#cta-trial', text: 'Start free trial', paths: ['*'] },
  { selector: '#nav-pricing', text: 'Pricing', paths: ['*'] },
  { selector: '#nav-features', text: 'Features', paths: ['*'] },
  { selector: '#nav-blog', text: 'Blog', paths: ['*'] },
  { selector: '#nav-login', text: 'Log in', paths: ['*'] },
  { selector: '#hero-cta', text: 'Start your free trial', paths: ['/', '/features/crm', '/features/helpdesk', '/features/mail', '/features/accounting', '/features/analytics'] },
  { selector: '#hero-secondary', text: 'Book a demo', paths: ['/', '/features/crm', '/features/helpdesk', '/features/mail', '/features/accounting', '/features/analytics'] },
  { selector: '#feature-crm', text: 'CRM', paths: ['/'] },
  { selector: '#feature-helpdesk', text: 'Helpdesk', paths: ['/'] },
  { selector: '#feature-mail', text: 'Mail', paths: ['/'] },
  { selector: '#plan-starter-cta', text: 'Choose Starter', paths: ['/pricing'] },
  { selector: '#plan-business-cta', text: 'Choose Business', paths: ['/pricing'] },
  { selector: '#plan-enterprise-cta', text: 'Talk to sales', paths: ['/pricing'] },
  { selector: '#footer-contact', text: 'Contact sales', paths: ['*'] },
  { selector: '#signup-submit', text: 'Create account', paths: ['/signup'] },
  { selector: '#login-submit', text: 'Sign in', paths: ['/login'] },
];

type Child = SerializedNode | string;

function node(tagName: string, attributes: Record<string, string>, children: Child[]): SerializedNode {
  return {
    type: 2,
    id: 0,
    tagName,
    attributes,
    childNodes: children.map((c): SerializedNode => (typeof c === 'string' ? { type: 3, id: 0, textContent: c } : c)),
  };
}

function h(tagName: string, attributes: Record<string, string> = {}, ...children: Child[]): SerializedNode {
  return node(tagName, attributes, children);
}

const CSS = `
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#171717;background:#fff;line-height:1.5}
a{color:inherit;text-decoration:none}
.wrap{max-width:1000px;margin:0 auto;padding:0 24px}
header{height:72px;border-bottom:1px solid #e5e5e5;background:#fff}
header .wrap{height:72px;display:flex;align-items:center;gap:28px}
.logo{font-weight:700;font-size:20px;letter-spacing:-0.02em;margin-right:auto}
.nav a{font-size:15px;color:#404040}
.btn{display:inline-block;padding:12px 22px;border-radius:8px;background:#171717;color:#fff;font-weight:600;font-size:15px}
.btn.small{padding:9px 16px;font-size:14px}
.btn.ghost{background:#fff;color:#171717;border:1px solid #d4d4d4}
.hero{padding:96px 0 80px}
.hero h1{font-size:52px;line-height:1.1;letter-spacing:-0.03em;margin:0 0 24px;max-width:720px}
.hero p{font-size:20px;color:#525252;margin:0 0 32px;max-width:620px}
.hero .actions{display:flex;gap:12px;flex-wrap:wrap}
.logos{display:flex;gap:40px;flex-wrap:wrap;padding:32px 0;border-top:1px solid #e5e5e5;border-bottom:1px solid #e5e5e5;color:#737373;font-weight:600}
.grid{display:flex;gap:20px;flex-wrap:wrap;padding:64px 0}
.card{flex:1 1 260px;border:1px solid #e5e5e5;border-radius:12px;padding:24px;background:#fafafa}
.card h3{margin:0 0 8px;font-size:20px}
.card p{margin:0;color:#525252}
.band{background:#171717;color:#fff;padding:64px 0;text-align:center}
.band h2{font-size:32px;margin:0 0 20px}
.band .btn{background:#fff;color:#171717}
.plans{display:flex;gap:20px;flex-wrap:wrap;padding:24px 0 64px}
.plan{flex:1 1 260px;border:1px solid #d4d4d4;border-radius:12px;padding:28px}
.plan.featured{border:2px solid #171717}
.plan .price{font-size:40px;font-weight:700;margin:12px 0}
.plan ul{padding-left:18px;color:#525252;min-height:140px}
.form{max-width:380px;margin:72px auto;padding:32px;border:1px solid #e5e5e5;border-radius:12px}
.form h1{font-size:26px;margin:0 0 20px}
.form label{display:block;font-size:14px;font-weight:600;margin:14px 0 6px}
.form .input{height:42px;border:1px solid #d4d4d4;border-radius:8px;padding:10px 12px;color:#737373}
.form .btn{display:block;text-align:center;margin-top:24px}
article{padding:56px 0;max-width:680px}
article h1{font-size:40px;line-height:1.15;letter-spacing:-0.02em;margin:0 0 16px}
article p{font-size:18px;color:#404040;margin:0 0 18px}
article h2{font-size:24px;margin:32px 0 12px}
.rows{padding:16px 0 56px}
.row{padding:20px 0;border-top:1px solid #e5e5e5}
.row h3{margin:0 0 4px;font-size:18px}
.row p{margin:0;color:#525252}
footer{padding:40px 0;border-top:1px solid #e5e5e5;color:#737373;font-size:14px}
footer .wrap{display:flex;gap:24px;flex-wrap:wrap}
.app{display:flex;min-height:900px}
.side{width:220px;flex:none;background:#fafafa;border-right:1px solid #e5e5e5;padding:20px 16px}
.side a{display:block;padding:8px 10px;border-radius:6px;color:#404040;font-size:14px}
.side a.on{background:#e5e5e5;font-weight:600}
.main{flex:1;padding:28px 32px}
.main h1{font-size:24px;margin:0 0 20px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:12px 10px;border-bottom:1px solid #e5e5e5}
th{color:#737373;font-weight:600}
`;

function titleFor(path: string, kind: PageKind): string {
  const pool = kind === 'app' ? APP_SCREENS : PAGES;
  return pool.find((p) => p.path === path)?.title ?? (kind === 'app' ? 'WeldSuite' : 'WeldSuite: one platform for your whole business');
}

function siteHeader(): SerializedNode {
  return h(
    'header',
    { id: 'site-header' },
    h(
      'div',
      { class: 'wrap' },
      h('a', { class: 'logo', id: 'logo', href: '/' }, 'WeldSuite'),
      h(
        'nav',
        { class: 'nav', style: 'display:flex;gap:24px' },
        h('a', { id: 'nav-features', href: '/features/crm' }, 'Features'),
        h('a', { id: 'nav-pricing', href: '/pricing' }, 'Pricing'),
        h('a', { id: 'nav-blog', href: '/blog' }, 'Blog'),
        h('a', { id: 'nav-login', href: '/login' }, 'Log in'),
      ),
      h('a', { id: 'cta-trial', class: 'btn small', href: '/signup' }, 'Start free trial'),
    ),
  );
}

function siteFooter(): SerializedNode {
  return h(
    'footer',
    {},
    h('div', { class: 'wrap' }, h('span', {}, '© 2026 WeldSuite'), h('a', { id: 'footer-contact', href: '/contact' }, 'Contact sales'), h('a', { href: '/about' }, 'About us'), h('a', { href: '/docs/getting-started' }, 'Docs')),
  );
}

function hero(title: string, text: string, withCtas: boolean): SerializedNode {
  return h(
    'section',
    { class: 'hero', id: 'hero' },
    h(
      'div',
      { class: 'wrap' },
      h('h1', {}, title),
      h('p', {}, text),
      withCtas ? h('div', { class: 'actions' }, h('a', { id: 'hero-cta', class: 'btn', href: '/signup' }, 'Start your free trial'), h('a', { id: 'hero-secondary', class: 'btn ghost', href: '/contact' }, 'Book a demo')) : '',
    ),
  );
}

function cards(items: Array<{ id?: string; title: string; text: string }>): SerializedNode {
  return h(
    'section',
    { class: 'wrap' },
    h('div', { class: 'grid' }, ...items.map((i) => h('div', { class: 'card', ...(i.id ? { id: i.id } : {}) }, h('h3', {}, i.title), h('p', {}, i.text)))),
  );
}

function plans(): SerializedNode {
  const plan = (key: string, name: string, price: string, perks: string[], cta: string, featured = false) =>
    h(
      'div',
      { class: featured ? 'plan featured' : 'plan', id: `plan-${key}` },
      h('h3', {}, name),
      h('div', { class: 'price' }, price),
      h('ul', {}, ...perks.map((p) => h('li', {}, p))),
      h('a', { id: `plan-${key}-cta`, class: featured ? 'btn' : 'btn ghost', href: '/signup' }, cta),
    );
  return h(
    'section',
    { class: 'wrap' },
    h(
      'div',
      { class: 'plans' },
      plan('starter', 'Starter', '€9 / user', ['CRM, mail and helpdesk', '1 workspace', 'Email support'], 'Choose Starter'),
      plan('business', 'Business', '€29 / user', ['Every module', 'Accounting and projects', 'Priority support', 'Automations'], 'Choose Business', true),
      plan('enterprise', 'Enterprise', 'Custom', ['Single sign-on', 'Dedicated EU hosting', 'Audit log', 'Success manager'], 'Talk to sales'),
    ),
  );
}

function formPage(title: string, fields: string[], submitId: string, submitText: string): SerializedNode {
  return h(
    'div',
    { class: 'form' },
    h('h1', {}, title),
    ...fields.flatMap((f) => [h('label', {}, f), h('div', { class: 'input' }, f === 'Password' ? '••••••••' : `Your ${f.toLowerCase()}`)]),
    h('a', { id: submitId, class: 'btn', href: '#' }, submitText),
  );
}

function articlePage(title: string): SerializedNode {
  return h(
    'div',
    { class: 'wrap' },
    h(
      'article',
      { id: 'article' },
      h('h1', {}, title),
      h('p', {}, 'Most teams we talk to run their business on eight to twelve separate tools. Each one is fine by itself. Together they cost time, money and a lot of copy and paste.'),
      h('p', {}, 'Over the last year we moved our own company onto one platform. This is what we learned, what went wrong and what we would do differently.'),
      h('h2', {}, 'Start with the data, not the tools'),
      h('p', {}, 'Before you switch anything off, list where your customers, invoices and conversations live today. Most of the pain is in the places where these meet.'),
      h('h2', {}, 'Move one team at a time'),
      h('p', {}, 'Sales moved first, then support, then finance. Each team kept its old tool read-only for a month, which took away the fear of losing something.'),
      h('p', {}, 'If you want to try the same, the getting started guide walks through the first week.'),
    ),
  );
}

function sitePage(path: string): SerializedNode[] {
  const title = titleFor(path, 'site');
  const body: SerializedNode[] = [];
  if (path === '/') {
    body.push(
      hero('One platform for your whole business', 'Customers, email, support, projects and accounting in one place, with your data kept in the EU.', true),
      h('div', { class: 'wrap' }, h('div', { class: 'logos' }, h('span', {}, 'Groenteman'), h('span', {}, 'Nordwind'), h('span', {}, 'Lumen Coffee'), h('span', {}, 'Atlas Property'), h('span', {}, 'Mercator'))),
      cards([
        { id: 'feature-crm', title: 'CRM', text: 'Keep every company, person and deal in one clean list.' },
        { id: 'feature-helpdesk', title: 'Helpdesk', text: 'Answer tickets and chats from a shared inbox.' },
        { id: 'feature-mail', title: 'Mail', text: 'Send and receive mail next to the customer record.' },
      ]),
      h('section', { class: 'band' }, h('div', { class: 'wrap' }, h('h2', {}, 'Try it with your own team'), h('a', { class: 'btn', href: '/signup' }, 'Start your free trial'))),
    );
  } else if (path === '/pricing') {
    body.push(hero('Simple pricing that grows with you', 'Pay per user. Every plan starts with a 14-day free trial.', false), plans());
  } else if (path.startsWith('/features/')) {
    body.push(
      hero(title.replace(' · WeldSuite', ''), 'Everything you need for this part of your business, working together with the rest of WeldSuite.', true),
      h('div', { class: 'wrap rows' }, h('div', { class: 'row' }, h('h3', {}, 'Built in, not bolted on'), h('p', {}, 'Shares its data with every other module.')), h('div', { class: 'row' }, h('h3', {}, 'Made for small teams'), h('p', {}, 'Up and running in an afternoon.')), h('div', { class: 'row' }, h('h3', {}, 'Your data stays yours'), h('p', {}, 'Hosted in the EU, exportable at any time.'))),
    );
  } else if (path === '/signup') {
    body.push(formPage('Create your account', ['Name', 'Work email', 'Password'], 'signup-submit', 'Create account'));
  } else if (path === '/login') {
    body.push(formPage('Sign in', ['Email', 'Password'], 'login-submit', 'Sign in'));
  } else if (path.startsWith('/blog/') || path.startsWith('/docs/')) {
    body.push(articlePage(title.replace(' · Docs', '')));
  } else if (path === '/blog' || path === '/customers') {
    body.push(
      hero(path === '/blog' ? 'Notes from the team' : 'Teams that run on WeldSuite', 'Short, practical reads about running a business with fewer tools.', false),
      h('div', { class: 'wrap rows' }, h('div', { class: 'row' }, h('h3', {}, 'How we replaced ten tools with one'), h('p', {}, 'What we learned moving our own company.')), h('div', { class: 'row' }, h('h3', {}, 'Your data stays in the EU'), h('p', {}, 'Where it lives and who can reach it.')), h('div', { class: 'row' }, h('h3', {}, 'A better way to run a helpdesk'), h('p', {}, 'Fewer tabs, faster answers.'))),
    );
  } else {
    body.push(hero(title.replace(' · WeldSuite', ''), 'Tell us a little about your team and we will get back to you within one working day.', true));
  }
  return [siteHeader(), ...body, siteFooter()];
}

function appPage(path: string): SerializedNode[] {
  const rows = ['Groenteman Installatietechniek', 'Nordwind Logistik', 'Lumen Coffee Roasters', 'Van den Berg Advocaten', 'Atlas Property Group', 'Kwekerij De Linde'];
  return [
    h(
      'div',
      { class: 'app' },
      h(
        'aside',
        { class: 'side', id: 'sidebar' },
        h('div', { class: 'logo', style: 'margin:0 0 20px 10px' }, 'WeldSuite'),
        ...APP_SCREENS.slice(0, 7).map((s) => h('a', { id: `side-${s.title.toLowerCase()}`, class: s.path === path ? 'on' : '', href: s.path }, s.title)),
      ),
      h(
        'main',
        { class: 'main' },
        h('h1', {}, titleFor(path, 'app')),
        h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Owner'), h('th', {}, 'Status'), h('th', {}, 'Updated'))), h('tbody', {}, ...rows.map((r, i) => h('tr', { id: `row-${i + 1}` }, h('td', {}, r), h('td', {}, ['Sanne', 'Lucas', 'Priya', 'Daniel'][i % 4]!), h('td', {}, i % 3 === 0 ? 'Open' : 'Active'), h('td', {}, `${i + 1} day${i === 0 ? '' : 's'} ago`))))),
      ),
    ),
  ];
}

/** Gives every node of the tree a unique id, in document order, and returns the next free id. */
function assignIds(root: SerializedNode, start: number): number {
  let next = start;
  const visit = (n: SerializedNode) => {
    n.id = next++;
    if (n.type === 0 || n.type === 2) n.childNodes.forEach(visit);
  };
  visit(root);
  return next;
}

export interface BuiltPage {
  /** The rrweb full snapshot `data.node`. */
  document: SerializedNode;
  /** Node id of each element that has an `id` attribute, plus `html` and `body`. */
  ids: Record<string, number>;
  /** The clickable things on the page, for the replay. */
  targets: ClickTarget[];
  /** Page height in px on a desktop viewport. */
  height: number;
}

function collectIds(n: SerializedNode, out: Record<string, number>): void {
  if (n.type !== 2) {
    if (n.type === 0) n.childNodes.forEach((c) => collectIds(c, out));
    return;
  }
  const htmlId = n.attributes.id;
  if (htmlId) out[htmlId] = n.id;
  if (n.tagName === 'html' || n.tagName === 'body') out[n.tagName] = n.id;
  n.childNodes.forEach((c) => collectIds(c, out));
}

/** Approximate click spots on a desktop page; other widths clamp into the viewport. */
function targetsFor(path: string, kind: PageKind): ClickTarget[] {
  if (kind === 'app') {
    return [
      { htmlId: 'row-1', label: 'Groenteman Installatietechniek', x: 420, y: 196, weight: 4 },
      { htmlId: 'row-2', label: 'Nordwind Logistik', x: 420, y: 240, weight: 3 },
      { htmlId: 'side-companies', label: 'Companies', x: 90, y: 90, weight: 2 },
      { htmlId: 'side-tickets', label: 'Tickets', x: 90, y: 130, weight: 2 },
    ];
  }
  const nav: ClickTarget[] = [
    { htmlId: 'nav-pricing', label: 'Pricing', x: 660, y: 36, weight: 4 },
    { htmlId: 'nav-features', label: 'Features', x: 590, y: 36, weight: 3 },
    { htmlId: 'cta-trial', label: 'Start free trial', x: 1130, y: 36, weight: 5 },
    { htmlId: 'nav-login', label: 'Log in', x: 800, y: 36, weight: 1.5 },
  ];
  if (path === '/') {
    return [...nav, { htmlId: 'hero-cta', label: 'Start your free trial', x: 240, y: 420, weight: 9 }, { htmlId: 'hero-secondary', label: 'Book a demo', x: 450, y: 420, weight: 3 }, { htmlId: 'feature-crm', label: 'CRM', x: 300, y: 820, weight: 2 }];
  }
  if (path === '/pricing') {
    return [...nav, { htmlId: 'plan-starter-cta', label: 'Choose Starter', x: 240, y: 640, weight: 3 }, { htmlId: 'plan-business-cta', label: 'Choose Business', x: 640, y: 640, weight: 8 }, { htmlId: 'plan-enterprise-cta', label: 'Talk to sales', x: 1000, y: 640, weight: 2 }];
  }
  if (path === '/signup') return [...nav, { htmlId: 'signup-submit', label: 'Create account', x: 640, y: 480, weight: 8 }];
  if (path === '/login') return [...nav, { htmlId: 'login-submit', label: 'Sign in', x: 640, y: 420, weight: 8 }];
  if (path.startsWith('/features/')) return [...nav, { htmlId: 'hero-cta', label: 'Start your free trial', x: 240, y: 420, weight: 6 }];
  return nav;
}

/** The stylesheet goes in as a <style> element whose text rrweb treats as CSS. */
function addStylesheet(doc: Extract<SerializedNode, { type: 0 }>): void {
  const html = doc.childNodes[1];
  if (!html || html.type !== 2) return;
  const head = html.childNodes[0];
  if (head && head.type === 2) head.childNodes[head.childNodes.length - 1] = { type: 2, id: 0, tagName: 'style', attributes: {}, childNodes: [{ type: 3, id: 0, textContent: CSS, isStyle: true }] };
}

/** How tall the page is, in pixels. */
function pageHeight(path: string, kind: PageKind): number {
  if (kind === 'app') return 900;
  if (path === '/') return 1700;
  if (path === '/pricing') return 1250;
  return path.startsWith('/blog/') ? 1500 : 1100;
}

/** The page at `path` as an rrweb document. Node ids start at 1; a second call gives a fresh tree. */
export function buildPage(path: string, kind: PageKind): BuiltPage {
  const content = kind === 'app' ? appPage(path) : sitePage(path);
  const doc: SerializedNode = {
    type: 0,
    id: 0,
    childNodes: [
      { type: 1, id: 0, name: 'html', publicId: '', systemId: '' },
      h(
        'html',
        { lang: 'en' },
        h('head', {}, h('meta', { charset: 'utf-8' }), h('title', {}, titleFor(path, kind)), { type: 3, id: 0, textContent: '' } as SerializedNode),
        h('body', {}, ...content),
      ),
    ],
  };
  addStylesheet(doc);
  assignIds(doc, 1);
  const ids: Record<string, number> = {};
  collectIds(doc, ids);
  return { document: doc, ids, targets: targetsFor(path, kind), height: pageHeight(path, kind) };
}

/** Which kind of page a path is. */
export function pageKindOf(path: string): PageKind {
  return APP_SCREENS.some((s) => s.path === path) ? 'app' : 'site';
}
