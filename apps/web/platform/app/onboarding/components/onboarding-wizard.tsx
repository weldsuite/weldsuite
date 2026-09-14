import { useRef, useState } from "react";
import { useOrganizationList } from "@clerk/clerk-react";
import { getTranslations } from "@/lib/i18n";
import { track } from "@/lib/analytics";
import { useCompleteOnboarding } from "@/hooks/use-onboarding";
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

export function OnboardingWizard(props: OnboardingWizardProps) {
  const { setActive } = useOrganizationList();
  const completeOnboarding = useCompleteOnboarding();
  const submittingRef = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showProvisioning, setShowProvisioning] = useState(false);

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

  return (
    <OnboardingSetup
      {...props}
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      error={error}
    />
  );
}
