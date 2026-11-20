/**
 * The rest of the install tab: reverse-proxy recipes (Next.js, Vercel,
 * Cloudflare Worker, nginx, from the SDK's recipes), the SDK options that
 * matter for setup (`apiHost`, super properties, groups, web vitals) and the
 * React Native SDK. Code is not translated.
 */

import { useState } from 'react';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { useI18n } from '@/lib/i18n/provider';
import { CopyBlock } from '../components/copy-block';
import { DEFAULT_PROXY_PATH, proxyRecipe, trimTrailingSlashes, type ProxyRecipeKind } from '../lib/proxy-recipes';

const RECIPES: readonly ProxyRecipeKind[] = ['nextjs', 'vercel', 'cloudflare-worker', 'nginx'];

/** `/wp` from what was typed: one leading slash, no trailing ones, letters, digits, `-` and `_` only. */
export function normalizeProxyPath(value: string): string {
  const cleaned = trimTrailingSlashes(value.trim()).replace(/[^A-Za-z0-9/_-]/g, '');
  if (cleaned === '' || cleaned === '/') return DEFAULT_PROXY_PATH;
  return cleaned.startsWith('/') ? cleaned : `/${cleaned}`;
}

/** The project's script snippet loading from the proxy path instead of the collector. */
export function proxiedSnippet(scriptSnippet: string, collectorUrl: string, path: string): string {
  return scriptSnippet.split(`${trimTrailingSlashes(collectorUrl)}/s.js`).join(`${path}/s.js`);
}

export function ProxySection({ scriptSnippet, collectorUrl }: Readonly<{ scriptSnippet: string; collectorUrl: string }>) {
  const { t } = useI18n();
  const tp = t.weldpanel.collab.proxy;
  const [rawPath, setRawPath] = useState(DEFAULT_PROXY_PATH);
  const path = normalizeProxyPath(rawPath);
  return (
    <SectionCard title={tp.title} description={tp.description}>
      <div className="grid gap-4">
        <div className="grid max-w-xs gap-1.5">
          <Label htmlFor="weldpanel-proxy-path">{tp.pathLabel}</Label>
          <Input id="weldpanel-proxy-path" value={rawPath} onChange={(event) => setRawPath(event.target.value)} className="font-mono" autoComplete="off" spellCheck={false} maxLength={40} />
        </div>
        <Tabs defaultValue="nextjs" className="gap-3">
          <TabsList className="h-auto max-w-full flex-wrap justify-start">
            {RECIPES.map((kind) => (
              <TabsTrigger key={kind} value={kind}>
                {tp.tabs[kind]}
              </TabsTrigger>
            ))}
          </TabsList>
          {RECIPES.map((kind) => (
            <TabsContent key={kind} value={kind}>
              <CopyBlock title={`${tp.recipeTitle} · ${tp.tabs[kind]}`} value={proxyRecipe(kind, { path, collector: collectorUrl })} />
            </TabsContent>
          ))}
        </Tabs>
        <CopyBlock title={tp.snippetTitle} value={proxiedSnippet(scriptSnippet, collectorUrl, path)} />
      </div>
    </SectionCard>
  );
}

const SUPER_PROPERTIES = [
  "weldpanel.register({ plan: 'pro', app_version: '2.4.0' });",
  "weldpanel.registerOnce({ signup_source: 'newsletter' });",
  "weldpanel.unregister('plan');",
].join('\n');

const GROUPS = [
  "weldpanel.group('company', 'acme-inc', { name: 'Acme Inc', plan: 'enterprise' });",
  "weldpanel.groups.set('company', 'acme-inc', { seats: 40 });",
  '// Later events carry $group_company: "acme-inc". Forget the groups on log out:',
  'weldpanel.resetGroups();',
].join('\n');

export function SdkOptionsSection() {
  const { t } = useI18n();
  const ts = t.weldpanel.collab.sdk;
  const options = [
    { option: 'apiHost', attribute: 'data-api-host', what: ts.options.apiHost },
    { option: 'webVitals: false', attribute: 'data-web-vitals="false"', what: ts.options.webVitals },
  ];
  return (
    <SectionCard title={ts.title} description={ts.description}>
      <div className="grid gap-5">
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{ts.columns.option}</TableHead>
                <TableHead>{ts.columns.attribute}</TableHead>
                <TableHead>{ts.columns.what}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {options.map((row) => (
                <TableRow key={row.option}>
                  <TableCell className="font-mono text-xs">{row.option}</TableCell>
                  <TableCell className="font-mono text-xs">{row.attribute}</TableCell>
                  <TableCell className="min-w-56 text-sm">{row.what}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <CopyBlock title={ts.superTitle} description={ts.superDescription} value={SUPER_PROPERTIES} />
        <CopyBlock title={ts.groupsTitle} description={ts.groupsDescription} value={GROUPS} />
      </div>
    </SectionCard>
  );
}

const RN_INSTALL = 'npm install @weldsuite/panel-react-native @react-native-async-storage/async-storage';

/** The React Native init snippet for a project token and collector. */
export function reactNativeSnippet(token: string, collectorUrl: string): string {
  return [
    "import AsyncStorage from '@react-native-async-storage/async-storage';",
    "import { createWeldPanel } from '@weldsuite/panel-react-native';",
    '',
    'export const panel = createWeldPanel({',
    `  token: '${token}',`,
    `  apiHost: '${trimTrailingSlashes(collectorUrl)}',`,
    '  storage: AsyncStorage,',
    "  app: { id: 'com.example.app', version: '1.0.0' },",
    '});',
    '',
    "panel.screen('Home');",
    "panel.track('Added to cart', { sku: 'A-100' });",
  ].join('\n');
}

export function ReactNativeSection({ token, collectorUrl }: Readonly<{ token: string; collectorUrl: string }>) {
  const { t } = useI18n();
  const tr = t.weldpanel.collab.reactNative;
  return (
    <SectionCard title={tr.title} description={tr.description}>
      <div className="grid gap-4">
        <CopyBlock title={tr.installTitle} value={RN_INSTALL} />
        <CopyBlock title={tr.initTitle} value={reactNativeSnippet(token, collectorUrl)} />
      </div>
    </SectionCard>
  );
}
