import { useRef, useState } from "react";
import { useOrganizationList } from "@clerk/clerk-react";
import { getTranslations } from "@/lib/i18n";
import { track } from "@/lib/analytics";
import { useCompleteOnboarding } from "@/hooks/use-onboarding";
import type { PartnerTerritoryErrorDetails } from "@weldsuite/app-api-client/schemas/partners";
import { TerritoryScreen } from "@/components/partner/territory-screen";
import { territoryErrorDetails } from "@/lib/partner/api-errors";
import { ProvisioningScreen } from "./provisioning-screen";
import {
  OnboardingSetup,
  type OnboardingSetupProps,
  type WorkspaceSetupData,
} from "./onboarding-setup";

type OnboardingWizardProps = Pick<
  OnboardingSetupProps,
  | "initialUserInfo"
  | "initialOrgInfo"
  | "availableApps"
  | "detectedCountry"
  | "defaultRegion"
>;

export function OnboardingWizard(props: Readonly<OnboardingWizardProps>) {
  const { setActive } = useOrganizationList();
  const completeOnboarding = useCompleteOnboarding();
  const submittingRef = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showProvisioning, setShowProvisioning] = useState(false);
  // Set when a partner serves the chosen country: no workspace was created.
  const [territory, setTerritory] = useState<{
    details: PartnerTerritoryErrorDetails;
    company: string;
    selectedApps: string[];
  } | null>(null);

  async function handleSubmit(data: WorkspaceSetupData) {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setIsSubmitting(true);
    setError(null);

    try {
      // Reuse the signed-in profile. Omit marketing/profile fields so setup
      // does not overwrite existing preferences.
      const response = await completeOnboarding.mutateAsync({
        ...data,
        firstName: props.initialUserInfo.firstName,
        lastName: props.initialUserInfo.lastName,
      });
      const result = response.data;
      if (!result.success) {
        throw new Error(
          getTranslations("common").onboarding.errors.failedToComplete,
        );
      }

      track("Onboarding Completed", {
        country: data.country,
        selected_apps: data.selectedApps,
      });

      if (result.clerkOrgId && setActive) {
        await setActive({ organization: result.clerkOrgId });
      }
      // Keep the existing readiness polling, retry, and finalization flow.
      setShowProvisioning(true);
    } catch (err) {
      const details = territoryErrorDetails(err);
      if (details) {
        setTerritory({
          details,
          company: data.organizationName,
          selectedApps: data.selectedApps,
        });
        setIsSubmitting(false);
        submittingRef.current = false;
        return;
      }
      setError(
        err instanceof Error
          ? err.message
          : getTranslations("common").onboarding.errors.unexpectedError,
      );
      setIsSubmitting(false);
      submittingRef.current = false;
    }
  }

  if (showProvisioning) return <ProvisioningScreen skipRetry />;

  if (territory) {
    return (
      <section className="flex min-h-screen items-center justify-center bg-background px-4 py-8">
        <div className="w-full max-w-lg">
          <TerritoryScreen
            details={territory.details}
            defaultCompany={territory.company}
            selectedApps={territory.selectedApps}
            onBack={() => setTerritory(null)}
            onClose={() => setTerritory(null)}
          />
        </div>
      </section>
    );
  }

  return (
    <OnboardingSetup
      {...props}
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      error={error}
    />
  );
}
