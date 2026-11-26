/** `$metadata` (CSDL XML), the service document, and the URLs the payloads carry. */

import {
  ODATA_CONTAINER,
  ODATA_ENTITY_SETS,
  ODATA_NAMESPACE,
  type ODataEntitySet,
  type ODataProperty,
} from '@weldsuite/desk-domain/odata-catalog';
import { encodeSkipToken, type SkipToken } from './query';

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function propertyXml(prop: ODataProperty): string {
  return `        <Property Name="${xmlEscape(prop.name)}" Type="${xmlEscape(prop.type)}" Nullable="${prop.nullable}"/>`;
}

function entityTypeXml(set: ODataEntitySet): string {
  return [
    `      <EntityType Name="${xmlEscape(set.entityType)}">`,
    '        <Key>',
    `          <PropertyRef Name="${xmlEscape(set.key)}"/>`,
    '        </Key>',
    ...set.properties.map(propertyXml),
    '      </EntityType>',
  ].join('\n');
}

/** The CSDL document: one EntityType per set, an EntityContainer listing the sets. */
export function metadataXml(): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">',
    '  <edmx:DataServices>',
    `    <Schema Namespace="${ODATA_NAMESPACE}" xmlns="http://docs.oasis-open.org/odata/ns/edm">`,
    ...ODATA_ENTITY_SETS.map(entityTypeXml),
    `      <EntityContainer Name="${ODATA_CONTAINER}">`,
    ...ODATA_ENTITY_SETS.map(
      (set) =>
        `        <EntitySet Name="${xmlEscape(set.name)}" EntityType="${ODATA_NAMESPACE}.${xmlEscape(set.entityType)}"/>`,
    ),
    '      </EntityContainer>',
    '    </Schema>',
    '  </edmx:DataServices>',
    '</edmx:Edmx>',
    '',
  ].join('\n');
}

export function serviceDocument(root: string) {
  return {
    '@odata.context': `${root}/$metadata`,
    value: ODATA_ENTITY_SETS.map((set) => ({ name: set.name, kind: 'EntitySet', url: set.name })),
  };
}

/** `<root>/$metadata#Set`, with the selected properties in parentheses. */
export function contextUrl(root: string, set: ODataEntitySet, select: ODataProperty[] | null, entity = false): string {
  const fields = select ? `(${select.map((p) => p.name).join(',')})` : '';
  return `${root}/$metadata#${set.name}${fields}${entity ? '/$entity' : ''}`;
}

const encode = (value: string): string => encodeURIComponent(value);

/**
 * The next page's URL: the caller's own options, minus `$skip` and `$top`
 * (the position is in the token; `$top` becomes what is left of it), plus
 * `$skiptoken`.
 */
export function nextLink(requestUrl: URL, token: SkipToken, remainingTop: number | null): string {
  const parts: string[] = [];
  for (const [name, value] of requestUrl.searchParams) {
    if (name === '$skip' || name === '$top' || name === '$skiptoken') continue;
    parts.push(`${name.startsWith('$') ? '$' + encode(name.slice(1)) : encode(name)}=${encode(value)}`);
  }
  if (remainingTop !== null) parts.push(`$top=${remainingTop}`);
  parts.push(`$skiptoken=${encodeSkipToken(token)}`);
  return `${requestUrl.origin}${requestUrl.pathname}?${parts.join('&')}`;
}
