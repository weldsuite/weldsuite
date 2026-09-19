import { useState } from "react";
import { z } from "zod";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@weldsuite/ui/components/input";
import { Label } from "@weldsuite/ui/components/label";
import { getTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { AppDefinition } from "@/lib/apps/catalog";
import {
  getAppIcon,
  getAppShortName,
  isHiddenFromOnboarding,
  resolveAppCode,
} from "@/lib/apps/app-registry";
import { COUNTRIES, NEON_REGIONS, getDefaultRegionForCountry } from "../types";

const workspaceSetupSchema = z.object({
  organizationName: z.string().trim().min(1).max(255),
  country: z
    .string()
    .refine((value) => COUNTRIES.some((country) => country.code === value)),
  region: z
    .string()
    .refine((value) => NEON_REGIONS.some((region) => region.id === value)),
  // A workspace always starts with at least one app, so the dashboard is never
  // empty on first login. `DEFAULT_APP_PREFERENCE` preselects one for the user.
  selectedApps: z.array(z.string()).min(1),
});

/** Relaxed variant for the rare case where the app catalog failed to load. */
const workspaceSetupWithoutAppsSchema = workspaceSetupSchema.extend({
  selectedApps: z.array(z.string()),
});

export type WorkspaceSetupData = z.infer<typeof workspaceSetupSchema>;

/**
 * Canonical app codes, best first, used to preselect one app for a brand-new
 * workspace. WeldCRM leads: contacts, customers and leads are the records every
 * other module hangs off, so it is the most useful single app to start with.
 * The catalog may serve legacy codes (`crm`, `projects`, ...), so entries are
 * matched through `resolveAppCode`.
 */
const DEFAULT_APP_PREFERENCE = [
  "weldcrm",
  "weldflow",
  "welddesk",
  "weldmail",
];

/** Pick the best available app to start with, or none if the catalog is empty. */
function pickDefaultApps(apps: AppDefinition[]): string[] {
  for (const preferred of DEFAULT_APP_PREFERENCE) {
    const match = apps.find((app) => resolveAppCode(app.code) === preferred);
    if (match) return [match.code];
  }
  return apps.length > 0 ? [apps[0].code] : [];
}

export interface OnboardingSetupProps {
  initialUserInfo: {
    firstName: string;
    lastName: string;
    email: string;
    imageUrl?: string;
  };
  initialOrgInfo: { id: string; name: string } | null;
  availableApps: AppDefinition[];
  detectedCountry: string;
  defaultRegion: string;
  onSubmit: (data: WorkspaceSetupData) => void;
  isSubmitting?: boolean;
  error?: string | null;
}

const selectClassName =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Shared by signup and the help preview; this view never calls live APIs. */
export function OnboardingSetup({
  initialUserInfo,
  initialOrgInfo,
  availableApps,
  detectedCountry,
  defaultRegion,
  onSubmit,
  isSubmitting = false,
  error,
}: OnboardingSetupProps) {
  const t = getTranslations("common");
  const copy = t.onboarding.quickStart;
  const [organizationName, setOrganizationName] = useState(
    initialOrgInfo?.name || "",
  );
  const [country, setCountry] = useState(() =>
    COUNTRIES.some((item) => item.code === detectedCountry)
      ? detectedCountry
      : "NL",
  );
  const [region, setRegion] = useState(() =>
    NEON_REGIONS.some((item) => item.id === defaultRegion)
      ? defaultRegion
      : getDefaultRegionForCountry(country),
  );
  const [hasCustomRegion, setHasCustomRegion] = useState(false);
  const visibleApps = availableApps.filter(
    (app) => !isHiddenFromOnboarding(app.code),
  );
  // `null` until the user touches the picker: the catalog arrives from a query,
  // so freezing the default in state would preselect nothing on first render.
  const [appSelection, setAppSelection] = useState<string[] | null>(null);
  const selectedApps = appSelection ?? pickDefaultApps(visibleApps);
  const selectedRegion = NEON_REGIONS.find((item) => item.id === region);
  // An empty catalog is a load failure, not a choice — don't trap the user
  // behind a requirement they have no way to satisfy.
  const validation = (
    visibleApps.length === 0
      ? workspaceSetupWithoutAppsSchema
      : workspaceSetupSchema
  ).safeParse({
    organizationName,
    country,
    region,
    selectedApps,
  });

  return (
    <section className="flex min-h-screen flex-col items-center bg-background px-4 py-8 sm:px-8">
      <img
        src="/assets/images/weldsuite/logo-horizontal-light.png"
        alt="WeldSuite"
        className="mb-8 h-8 dark:hidden"
      />
      <img
        src="/assets/images/weldsuite/logo-horizontal-dark.png"
        alt="WeldSuite"
        className="mb-8 hidden h-8 dark:block"
      />
      <div className="my-auto grid w-full max-w-4xl overflow-hidden rounded-2xl border lg:grid-cols-[1.2fr_1fr]">
        <div className="p-6 sm:p-10">
          <h1 className="text-2xl font-semibold tracking-tight">
            {copy.title}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {copy.description}
          </p>
          {initialUserInfo.email && (
            <p className="mt-3 break-all text-xs text-muted-foreground">
              {copy.signedInAs.replace("{email}", initialUserInfo.email)}
            </p>
          )}

          <form
            className="mt-8"
            onSubmit={(event) => {
              event.preventDefault();
              if (validation.success && !isSubmitting)
                onSubmit(validation.data);
            }}
          >
            <fieldset
              disabled={isSubmitting}
              className="min-w-0 space-y-6 disabled:opacity-70"
            >
              <div className="space-y-2">
                <Label htmlFor="organizationName">{copy.nameLabel}</Label>
                <Input
                  id="organizationName"
                  value={organizationName}
                  onChange={(event) => setOrganizationName(event.target.value)}
                  placeholder={copy.namePlaceholder}
                  autoComplete="organization"
                  maxLength={255}
                  required
                  aria-describedby="workspace-name-hint"
                />
                <p
                  id="workspace-name-hint"
                  className="text-xs text-muted-foreground"
                >
                  {copy.nameHint}
                </p>
              </div>

              <details className="group rounded-xl border p-4">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
                  <span>
                    {copy.locationSettings}
                    <span className="mt-1 block text-xs font-normal text-muted-foreground">
                      {selectedRegion?.label}
                    </span>
                  </span>
                  <ChevronDown
                    aria-hidden="true"
                    className="size-4 shrink-0 transition-transform group-open:rotate-180"
                  />
                </summary>
                <div className="mt-4 space-y-4">
                  <p className="text-xs text-muted-foreground">
                    {copy.locationHint}
                  </p>
                  <div className="space-y-2">
                    <Label htmlFor="country">
                      {t.onboarding.workspaceStep.countryLabel}
                    </Label>
                    <select
                      id="country"
                      className={selectClassName}
                      value={country}
                      onChange={(event) => {
                        setCountry(event.target.value);
                        if (!hasCustomRegion)
                          setRegion(
                            getDefaultRegionForCountry(event.target.value),
                          );
                      }}
                    >
                      {COUNTRIES.map((item) => (
                        <option key={item.code} value={item.code}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="region">
                      {t.onboarding.workspaceStep.regionLabel}
                    </Label>
                    <select
                      id="region"
                      className={selectClassName}
                      value={region}
                      onChange={(event) => {
                        setRegion(event.target.value);
                        setHasCustomRegion(true);
                      }}
                    >
                      {NEON_REGIONS.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </details>

              <details className="group rounded-xl border p-4">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
                  <span>
                    {copy.chooseApps}
                    <span className="mt-1 block text-xs font-normal text-muted-foreground">
                      {selectedApps.length > 0
                        ? (selectedApps.length === 1
                            ? t.onboarding.appsStep.appsSelected
                            : t.onboarding.appsStep.appsSelectedPlural
                          ).replace("{count}", String(selectedApps.length))
                        : visibleApps.length === 0
                          ? copy.appsLater
                          : copy.appsRequired}
                    </span>
                  </span>
                  <ChevronDown
                    aria-hidden="true"
                    className="size-4 shrink-0 transition-transform group-open:rotate-180"
                  />
                </summary>
                <p className="mt-4 text-xs text-muted-foreground">
                  {t.onboarding.appsStep.description}
                </p>
                <div className="mt-3 flex max-h-64 flex-wrap gap-2 overflow-y-auto">
                  {visibleApps.map((app) => {
                    const selected = selectedApps.includes(app.code);
                    const icon = getAppIcon(app.code);
                    return (
                      <button
                        key={app.code}
                        type="button"
                        aria-pressed={selected}
                        data-testid="onboarding-app-btn"
                        className={cn(
                          "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          selected && "border-primary bg-primary/5",
                        )}
                        onClick={() =>
                          setAppSelection(
                            selected
                              ? selectedApps.filter(
                                  (code) => code !== app.code,
                                )
                              : [...selectedApps, app.code],
                          )
                        }
                      >
                        {icon && <img src={icon} alt="" className="size-4" />}
                        {getAppShortName(app.code, app.name)}
                        {selected && (
                          <Check aria-hidden="true" className="size-3" />
                        )}
                      </button>
                    );
                  })}
                </div>
                {visibleApps.length === 0 && (
                  <p className="mt-3 text-sm text-muted-foreground">
                    {copy.appsUnavailable}
                  </p>
                )}
              </details>

              {error && (
                <p
                  role="alert"
                  className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
                >
                  {error}
                </p>
              )}
              <Button
                type="submit"
                disabled={!validation.success || isSubmitting}
                className="w-full"
                data-testid="onboarding-get-started-btn"
              >
                {isSubmitting && (
                  <Loader2
                    aria-hidden="true"
                    className="mr-2 size-4 animate-spin"
                  />
                )}
                {isSubmitting
                  ? t.onboarding.appsStep.settingUp
                  : copy.createWorkspace}
              </Button>
            </fieldset>
          </form>
        </div>
        <aside className="hidden flex-col justify-center gap-6 border-l bg-muted/40 p-10 lg:flex">
          <h2 className="text-xl font-semibold">{copy.nextTitle}</h2>
          <ul className="space-y-5 text-sm text-muted-foreground">
            {[copy.nextApps, copy.nextProfile, copy.nextTeam].map((item) => (
              <li key={item} className="flex gap-3">
                <Check
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0 text-primary"
                />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </aside>
      </div>
      <footer className="mt-8 flex flex-wrap justify-center gap-4 text-xs text-muted-foreground">
        <span>&copy; {new Date().getFullYear()} WeldSuite</span>
        <a href="/privacy" className="hover:underline">
          {t.onboarding.footer.privacyPolicy}
        </a>
        <a href="/terms" className="hover:underline">
          {t.onboarding.footer.termsOfService}
        </a>
      </footer>
    </section>
  );
}
