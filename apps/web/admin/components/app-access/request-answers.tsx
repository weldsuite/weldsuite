import { Check, TriangleAlert } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { WELDREACH_TERMS } from '@weldsuite/app-api-client/schemas/reach';
import { TERM_LABELS, countryLabel, isConsentCountry, listSourceLabel } from '@/lib/app-access';
import { formatDateTime } from '@/lib/billing-format';
import type { AppAccessDetail } from '@/lib/app-access-data';

/**
 * Everything the workspace answered when it asked for access, with the terms
 * it ticked one by one. The reviewer reads this to decide, so nothing is
 * shortened: the use case and list details are shown in full.
 */
export function RequestAnswers({ request, requestedByEmail }: Readonly<{
  request: NonNullable<AppAccessDetail['request']>;
  requestedByEmail: string | null;
}>) {
  const consentCountries = request.targetCountries.filter(isConsentCountry);
  const accepted = new Set(request.termsAccepted);
  const termKeys = [...WELDREACH_TERMS] as string[];
  // Anything ticked that the current contract does not know (an older terms version) is listed too.
  const extraKeys = request.termsAccepted.filter((key) => !termKeys.includes(key));

  return (
    <div className="space-y-4">
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <Answer label="Company">{request.companyName}</Answer>
        <Answer label="Website">
          <a
            href={/^https?:\/\//i.test(request.website) ? request.website : `https://${request.website}`}
            target="_blank"
            rel="noreferrer noopener"
            className="break-all underline underline-offset-2"
          >
            {request.website}
          </a>
        </Answer>
        <Answer label="Contact">
          {request.contactName}
          <span className="block text-xs text-muted-foreground">{request.contactEmail}</span>
        </Answer>
        <Answer label="Filed by">{requestedByEmail ?? request.termsAcceptedBy}</Answer>
        <Answer label="Expected sends per day">{request.expectedDailySends.toLocaleString('en-GB')}</Answer>
        <Answer label="List source">
          {listSourceLabel(request.listSource)}
          {request.listSource === 'bought_list' && (
            <Badge variant="warning" className="ml-2 text-[10px]">
              check
            </Badge>
          )}
        </Answer>
        <Answer label="Target countries" wide>
          <div className="flex flex-wrap gap-1.5">
            {request.targetCountries.map((code) => (
              <Badge key={code} variant={isConsentCountry(code) ? 'warning' : 'outline'} className="font-normal">
                {countryLabel(code)}
              </Badge>
            ))}
          </div>
          {consentCountries.length > 0 && (
            <p className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {consentCountries.join(', ')} need prior consent for business addresses too, unless there is an existing
              customer relationship.
            </p>
          )}
        </Answer>
        {request.listSourceDetails && (
          <Answer label="List details" wide>
            <p className="whitespace-pre-wrap">{request.listSourceDetails}</p>
          </Answer>
        )}
        <Answer label="Use case" wide>
          <p className="whitespace-pre-wrap">{request.useCase}</p>
        </Answer>
      </dl>

      <div>
        <h3 className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
          Terms accepted
          <span className="ml-2 normal-case tracking-normal">
            {request.termsVersion} · {formatDateTime(request.termsAcceptedAt)}
          </span>
        </h3>
        <ul className="space-y-1.5 text-sm">
          {termKeys.map((key) => (
            <li key={key} className="flex items-start gap-2">
              {accepted.has(key) ? (
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
              ) : (
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              )}
              <span className={accepted.has(key) ? undefined : 'text-destructive'}>
                {TERM_LABELS[key as keyof typeof TERM_LABELS]}
                {!accepted.has(key) && ' (not accepted)'}
              </span>
            </li>
          ))}
          {extraKeys.map((key) => (
            <li key={key} className="flex items-start gap-2 text-muted-foreground">
              <Check className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="font-mono text-xs">{key}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Answer({ label, wide, children }: Readonly<{ label: string; wide?: boolean; children: React.ReactNode }>) {
  return (
    <div className={wide ? 'sm:col-span-2' : undefined}>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}
