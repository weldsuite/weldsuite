/**
 * "From Acme BV": where a request started, linking to the WeldDrive file or the
 * CRM record. A file or record that was deleted since is said so, without a link.
 */

import { Briefcase, Building2, FileText, User, type LucideIcon } from 'lucide-react';
import type { SignSourceDto, SignSourceType } from '@weldsuite/app-api-client/schemas/weldsign';
import { Link } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { sourceHref } from '../lib/source';

export const SOURCE_ICON: Record<SignSourceType, LucideIcon> = {
  file: FileText,
  company: Building2,
  person: User,
  opportunity: Briefcase,
};

/**
 * A translated sentence with a name in it ("From {name}", "Van {name}"), the
 * name being the link. The sentence stays whole, so translations may put the
 * name anywhere.
 */
export function LinkedName({ template, name, href }: Readonly<{ template: string; name: string; href: string }>) {
  const [before = '', after = ''] = template.split('{name}');
  return (
    <span className="min-w-0 break-words">
      {before}
      <Link href={href} className="font-medium text-foreground underline-offset-4 hover:underline">
        {name}
      </Link>
      {after}
    </span>
  );
}

export function SourceLine({ source }: Readonly<{ source: SignSourceDto | null | undefined }>) {
  const { t } = useI18n();
  if (!source) return null;

  const ts = t.weldsign.source;
  const Icon = SOURCE_ICON[source.entityType];

  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <Icon className="size-4 shrink-0" aria-hidden />
      {source.name === null ? (
        <span>{ts.gone[source.entityType]}</span>
      ) : (
        <LinkedName template={ts.from} name={source.name} href={sourceHref(source.entityType, source.entityId)} />
      )}
    </p>
  );
}
