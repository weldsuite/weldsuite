
import * as React from 'react';
import { useRef } from 'react';
import { getTranslations } from '@/lib/i18n';
import { useUser, useOrganizationList } from '@clerk/clerk-react';
import { track } from '@/lib/analytics';
import { motion } from 'framer-motion';
import { Check, ChevronLeft, Plus, Loader2, Info, ChevronsUpDown, Search } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@weldsuite/ui/components/tooltip';
import { cn } from '@/lib/utils';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { useCompleteOnboarding } from '@/hooks/use-onboarding';
import { ProvisioningScreen } from './provisioning-screen';
import type { AppDefinition } from '@/lib/apps/catalog';
import {
  ORGANIZATION_TYPES,
  ORGANIZATION_SIZES,
  ROLES,
  COUNTRIES,
  REFERRAL_SOURCES,
  NEON_REGIONS,
  getDefaultRegionForCountry,
  type OnboardingFormData,
} from '../types';
import { getAppIcon, getAppLucideIcon, getAppShortName, isHiddenFromOnboarding } from '@/lib/apps/app-registry';
import { LucideDynamicIcon } from '@/components/lucide-dynamic-icon';

// Dynamic icon component for database icon names (e.g. "ShoppingCart")
const DynamicIcon = ({ name, className }: { name: string; className?: string }) => (
  <LucideDynamicIcon name={name} className={className} />
);

// Profile Picture Upload Component
interface FileInputProps {
  label: string;
  name: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRemove: () => void;
  value: string | null;
  canRemove?: boolean;
  description?: string;
}

const FileInput = ({
  label,
  name,
  onChange,
  onRemove,
  value,
  canRemove = true,
  description,
}: FileInputProps) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const t = getTranslations('common');

  const handleUploadFile = () => {
    fileInputRef.current?.click();
  };

  return (
    <div className="flex items-center gap-4">
      <div
        onClick={handleUploadFile}
        className="flex size-18 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-3xl border bg-muted"
      >
        {value ? (
          <img
            src={value}
            alt={t.onboarding.profileStep.profilePictureLabel}
            className="size-full object-cover"
          />
        ) : (
          <Plus className="size-5 text-muted-foreground" />
        )}
      </div>
      <div className="space-y-3">
        <div className="flex items-center gap-1.5">
          <Label>{label}</Label>
          {description && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="size-3.5 text-muted-foreground cursor-help" />
                </TooltipTrigger>
                <TooltipContent>
                  <p>{description}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="file"
            name={name}
            ref={fileInputRef}
            className="hidden"
            accept="image/png,image/jpeg,image/jpg,image/gif,image/webp"
            onChange={onChange}
          />
          <Button
            variant="outline"
            type="button"
            size="sm"
            onClick={handleUploadFile}
          >
            {t.onboarding.profileStep.uploadImage}
          </Button>
          {value && canRemove && (
            <Button
              variant="outline"
              type="button"
              size="sm"
              onClick={onRemove}
            >
              {t.onboarding.profileStep.remove}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

interface OnboardingWizardProps {
  initialUserInfo: {
    firstName: string;
    lastName: string;
    email: string;
    imageUrl?: string;
  };
  initialOrgInfo: {
    id: string;
    name: string;
  } | null;
  availableApps: AppDefinition[];
  detectedCountry: string;
  defaultRegion: string;
}

interface StepHeaderProps {
  title: string;
  stepIndex: number;
  totalSteps: number;
  goBack?: () => void;
}

const StepHeader = ({ title, stepIndex, totalSteps, goBack }: StepHeaderProps) => {
  return (
    <div className="relative">
      {goBack && stepIndex > 0 && (
        <Button
          variant="ghost"
          size="icon"
          onClick={goBack}
          className="absolute top-1/2 right-full -translate-x-1/2 -translate-y-1/2"
        >
          <ChevronLeft className="size-4" />
        </Button>
      )}
      <div>
        <p className="text-sm font-medium text-muted-foreground">
          {stepIndex + 1}/{totalSteps}
        </p>
        <h3 className="mt-2 text-2xl font-semibold tracking-tight md:whitespace-nowrap">
          {title}
        </h3>
      </div>
    </div>
  );
};

const StepContainer = ({ children }: { children: React.ReactNode }) => {
  return (
    <div className="flex w-full max-w-6xl flex-col-reverse gap-10 md:gap-0 sm:rounded-2xl sm:border md:min-h-[40dvh] md:flex-row lg:rounded-3xl">
      {children}
    </div>
  );
};

interface StepLeftWrapperProps {
  title: string;
  currentStep: number;
  totalSteps: number;
  children: React.ReactNode;
  goBack?: () => void;
}

const StepLeftWrapper = ({
  title,
  currentStep,
  totalSteps,
  goBack,
  children,
}: StepLeftWrapperProps) => {
  return (
    <div className="flex w-full md:w-1/2 justify-center px-6 py-8 sm:px-10 md:py-12 lg:px-16">
      <div className="flex h-full w-full max-w-md shrink-0 flex-col gap-6 md:min-h-[520px]">
        <StepHeader
          title={title}
          stepIndex={currentStep}
          totalSteps={totalSteps}
          goBack={goBack}
        />
        {children}
      </div>
    </div>
  );
};

const StepRightWrapper = ({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) => {
  return (
    <div
      className={cn(
        'hidden w-1/2 overflow-hidden py-8 md:py-12 lg:flex items-center justify-end pl-20 bg-muted/50 border-l sm:rounded-r-2xl lg:rounded-r-3xl',
        className
      )}
    >
      {children}
    </div>
  );
};

interface DashboardIllustrationProps {
  image?: string | null;
  variant?: 'zoomed-in' | 'zoomed-out';
  title?: string;
  transformOrigin?: string;
  className?: string;
  userName?: string;
  userEmail?: string;
  userImage?: string | null;
  selectedApps?: AppDefinition[];
}

const DashboardIllustration = ({
  image,
  variant = 'zoomed-out',
  title = 'Workspace',
  transformOrigin = '-20% -10%',
  className,
  userName = '',
  userEmail = '',
  userImage,
  selectedApps = [],
}: DashboardIllustrationProps) => {
  return (
    <motion.div
      style={{ transformOrigin }}
      animate={{ scale: variant === 'zoomed-in' ? 1.3 : 1 }}
      transition={{ type: 'spring', stiffness: 300, damping: 40 }}
      className={cn(
        'flex h-[91%] w-[510px] overflow-hidden rounded-l-xl border border-border/50 border-r-0 bg-background shadow-[0_0_30px_rgba(0,0,0,0.03)]',
        className
      )}
    >
      {/* Mini Sidebar */}
      <div className="h-full w-[46px] shrink-0 bg-background border-r border-border/50 flex flex-col items-center py-3 gap-1">
        {/* Selected app icons */}
        {selectedApps.slice(0, 6).map((app, index) => (
          <div key={`mini-icon-${index}`} className="size-8 rounded-lg flex items-center justify-center bg-muted/30">
            {getAppIcon(app.code) ? (
              <img src={getAppIcon(app.code)} alt={app.name} className="size-4" />
            ) : (
              <DynamicIcon name={app.icon} className="size-4 text-muted-foreground/60" />
            )}
          </div>
        ))}
        {/* Placeholder icons only when less than 4 apps selected */}
        {selectedApps.length < 4 && Array.from({ length: 4 - selectedApps.length }).map((_, index) => (
          <div key={`placeholder-icon-${index}`} className="size-8 rounded-lg flex items-center justify-center">
            <div className="size-7 rounded-md bg-muted/50" />
          </div>
        ))}
        {/* Spacer */}
        <div className="flex-1" />
        {/* Add button */}
        <div className="size-8 rounded-lg border border-dashed border-muted-foreground/20 flex items-center justify-center">
          <Plus className="size-3 text-muted-foreground/30" />
        </div>
      </div>
      {/* Sidebar */}
      <div className="h-full w-[195px] shrink-0 overflow-hidden bg-muted/30 border-r border-border/50 flex flex-col">
        {/* Logo / Organization name */}
        <div className="flex items-center gap-2 p-4">
          <div className="size-5 shrink-0 rounded bg-muted" />
          <p className="text-xs font-medium text-muted-foreground/70 truncate">
            {title || 'Workspace'}
          </p>
        </div>
        {/* Menu items */}
        <div className="space-y-1 px-3">
          {Array.from({ length: 5 }).map((_, index) => (
            <div
              key={`sidebar-tab-${index}`}
              className="flex items-center gap-2 h-8 px-2 rounded-md"
            >
              <div className="size-4 rounded bg-muted/50" />
              <div className="h-3 flex-1 rounded bg-muted/30" />
            </div>
          ))}
        </div>
        {/* Section label */}
        <div className="px-5 pt-4 pb-2">
          <div className="h-2.5 w-10 rounded bg-muted/40" />
        </div>
        {/* More menu items */}
        <div className="space-y-1 px-3">
          {Array.from({ length: 4 }).map((_, index) => (
            <div
              key={`sidebar-tab-2-${index}`}
              className="flex items-center gap-2 h-8 px-2 rounded-md"
            >
              <div className="size-4 rounded bg-muted/60" />
              <div className="h-3 flex-1 rounded bg-muted/40" />
            </div>
          ))}
        </div>
        {/* Spacer */}
        <div className="flex-1" />
        {/* User profile at bottom */}
        <div className="flex items-center gap-2 p-3 border-t border-muted/30">
          <div className="size-[24px] rounded-md bg-primary/40 flex items-center justify-center text-[10px] font-medium text-primary-foreground/70 overflow-hidden">
            {userImage ? (
              <img src={userImage} alt="Avatar" className="size-full object-cover" />
            ) : (
              userName ? userName.charAt(0).toUpperCase() : 'U'
            )}
          </div>
          <div className="flex-1 min-w-0 -space-y-[1px] translate-y-[2px]">
            <p className="text-xs font-medium text-muted-foreground/80 truncate">
              {userName || 'Your Name'}
            </p>
            <p className="text-[10px] text-muted-foreground/50 truncate">
              {userEmail || 'email@example.com'}
            </p>
          </div>
          <ChevronLeft className="size-3 rotate-[270deg] text-muted-foreground/40" />
        </div>
      </div>
      {/* Main content */}
      <div className="flex flex-1 flex-col p-4">
        <div className="space-y-4">
          {/* Header */}
          <div className="flex items-center gap-3">
            <div className="h-7 w-24 rounded-md bg-muted/40" />
            <div className="h-7 w-7 rounded-md bg-muted/30" />
          </div>
          {/* Content rows */}
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={`row-${index}`} className="flex items-center gap-3">
                <div className="h-6 w-6 rounded bg-muted/30" />
                <div className="h-5 flex-1 rounded bg-muted/20" />
                <div className="h-5 w-16 rounded bg-muted/20" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </motion.div>
  );
};

export function OnboardingWizard({ initialUserInfo, initialOrgInfo, availableApps, detectedCountry, defaultRegion }: OnboardingWizardProps) {
  const t = getTranslations('common');
  const { user } = useUser();
  const { setActive } = useOrganizationList();
  const [currentStep, setCurrentStep] = React.useState(0);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Once the workspace+org are created we hand off to the provisioning screen,
  // which polls for readiness, surfaces failures with a retry, and finalizes.
  const [showProvisioning, setShowProvisioning] = React.useState(false);
  const completeOnboardingMutation = useCompleteOnboarding();
  const submittingRef = useRef(false);

  // Profile picture state
  const [profilePictureFile, setProfilePictureFile] = React.useState<File | null>(null);
  const [profilePicturePreview, setProfilePicturePreview] = React.useState<string | null>(
    initialUserInfo.imageUrl || null
  );

  // Selected apps state (array to preserve selection order)
  const [selectedApps, setSelectedApps] = React.useState<string[]>([]);

  const [formData, setFormData] = React.useState<OnboardingFormData>({
    firstName: initialUserInfo.firstName,
    lastName: initialUserInfo.lastName,
    productUpdates: true,
    organizationName: initialOrgInfo?.name || '',
    organizationType: '',
    country: detectedCountry,
    organizationSize: '',
    referralSource: '',
    region: defaultRegion,
    role: '',
  });

  const toggleApp = (appCode: string) => {
    setSelectedApps((prev) => {
      if (prev.includes(appCode)) {
        return prev.filter((c) => c !== appCode);
      } else {
        return [...prev, appCode];
      }
    });
  };

  const updateFormData = (field: keyof OnboardingFormData, value: string | boolean) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const handleProfilePictureChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setProfilePictureFile(file);
      setProfilePicturePreview(URL.createObjectURL(file));
    }
  };

  const handleProfilePictureRemove = () => {
    setProfilePictureFile(null);
    setProfilePicturePreview(null);
  };

  const handleNext = () => {
    if (currentStep < 3) {
      setCurrentStep(currentStep + 1);
    }
  };

  const handleBack = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    }
  };

  const handleSubmit = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setIsSubmitting(true);
    setError(null);

    try {
      // Upload profile picture to Clerk if a new one was selected
      if (profilePictureFile && user) {
        try {
          await user.setProfileImage({ file: profilePictureFile });
        } catch (imgError) {
          console.error('[Onboarding] Failed to upload profile image:', imgError);
          // Continue with onboarding even if image upload fails
        }
      }

      // Call api-worker to create org + provision DB + setup billing
      const response = await completeOnboardingMutation.mutateAsync({
        ...formData,
        selectedApps: Array.from(selectedApps),
      });

      const result = response.data;

      if (!result.success) {
        const t = getTranslations('common');
        setError(t.onboarding.errors.failedToComplete);
        setIsSubmitting(false);
        submittingRef.current = false;
        return;
      }

      track('Onboarding Completed', {
        organization_type: formData.organizationType,
        organization_size: formData.organizationSize,
        role: formData.role,
        country: formData.country,
        referral_source: formData.referralSource,
        selected_apps: Array.from(selectedApps),
      });

      if (result.clerkOrgId && setActive) {
        // Set active org in Clerk client session
        await setActive({ organization: result.clerkOrgId });
      }

      // Hand off to the provisioning screen — it polls for readiness, shows a
      // retry on failure, finalizes, and only then redirects into the dashboard.
      setShowProvisioning(true);
    } catch (err) {
      const t = getTranslations('common');
      setError(err instanceof Error ? err.message : t.onboarding.errors.unexpectedError);
      setIsSubmitting(false);
      submittingRef.current = false;
    }
  };

  const totalSteps = 4;

  // After submit, the provisioning screen owns the rest of onboarding (polling,
  // failure/retry, finalize, redirect). skipRetry: provisioning was just kicked off.
  if (showProvisioning) {
    return <ProvisioningScreen skipRetry />;
  }

  return (
    <section className="min-h-screen flex flex-col">
      {/* Logo - Top */}
      <div className="py-6 flex justify-center">
        <img
          src="/assets/images/weldsuite/logo-horizontal-light.png"
          alt="WeldSuite"
          className="h-8 dark:hidden"
        />
        <img
          src="/assets/images/weldsuite/logo-horizontal-dark.png"
          alt="WeldSuite"
          className="h-8 hidden dark:block"
        />
      </div>

      {/* Content - Center */}
      <div className="flex-1 flex flex-col items-center justify-center py-6 md:py-10">
        <div className="container flex flex-col items-center justify-center gap-8">
          {/* Error message */}
          {error && (
            <div className="w-full max-w-4xl p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600 text-center">
              {error}
            </div>
          )}

          {/* Steps */}
          <StepContainer>
            {currentStep === 0 && (
              <ProfileStepContent
                formData={formData}
                updateFormData={updateFormData}
                onNext={handleNext}
                currentStep={currentStep}
                totalSteps={totalSteps}
                profilePicturePreview={profilePicturePreview}
                hasCustomProfilePicture={!!profilePictureFile}
                onProfilePictureChange={handleProfilePictureChange}
                onProfilePictureRemove={handleProfilePictureRemove}
                email={initialUserInfo.email}
              />
            )}

            {currentStep === 1 && (
              <OrganizationStepContent
                formData={formData}
                updateFormData={updateFormData}
                onNext={handleNext}
                onBack={handleBack}
                currentStep={currentStep}
                totalSteps={totalSteps}
              />
            )}

            {currentStep === 2 && (
              <RoleStepContent
                formData={formData}
                updateFormData={updateFormData}
                onNext={handleNext}
                onBack={handleBack}
                currentStep={currentStep}
                totalSteps={totalSteps}
              />
            )}

            {currentStep === 3 && (
              <AppsStepContent
                availableApps={availableApps}
                selectedApps={selectedApps}
                toggleApp={toggleApp}
                onSubmit={handleSubmit}
                onBack={handleBack}
                currentStep={currentStep}
                totalSteps={totalSteps}
                isSubmitting={isSubmitting}
              />
            )}

            {/* Single DashboardIllustration that persists across all steps */}
            <StepRightWrapper>
              <DashboardIllustration
                variant={currentStep === 1 ? 'zoomed-in' : 'zoomed-out'}
                transformOrigin="-20% -10%"
                title={formData.organizationName || 'Workspace'}
                userName={[formData.firstName, formData.lastName].filter(Boolean).join(' ')}
                userEmail={initialUserInfo.email}
                userImage={profilePicturePreview}
                selectedApps={selectedApps
                  .map((code) => availableApps.find((app) => app.code === code)!)
                  .filter(Boolean)}
              />
            </StepRightWrapper>
          </StepContainer>
        </div>
      </div>

      {/* Footer - Bottom */}
      <div className="py-6 flex items-center justify-center gap-4 text-xs text-muted-foreground">
        <p>&copy; {new Date().getFullYear()} WeldSuite</p>
        <span className="text-muted-foreground/50">|</span>
        <a href="/privacy" className="hover:underline">
          {t.onboarding.footer.privacyPolicy}
        </a>
        <span className="text-muted-foreground/50">|</span>
        <a href="/terms" className="hover:underline">
          {t.onboarding.footer.termsOfService}
        </a>
      </div>
    </section>
  );
}

// Step 1: Profile Content (left side only)
interface ProfileStepContentProps {
  formData: OnboardingFormData;
  updateFormData: (field: keyof OnboardingFormData, value: string | boolean) => void;
  onNext: () => void;
  currentStep: number;
  totalSteps: number;
  profilePicturePreview: string | null;
  hasCustomProfilePicture: boolean;
  onProfilePictureChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onProfilePictureRemove: () => void;
  email: string;
}

function ProfileStepContent({
  formData,
  updateFormData,
  onNext,
  currentStep,
  totalSteps,
  profilePicturePreview,
  hasCustomProfilePicture,
  onProfilePictureChange,
  onProfilePictureRemove,
  email,
}: ProfileStepContentProps) {
  const t = getTranslations('common');
  const canContinue = formData.firstName.trim() && formData.lastName.trim();

  return (
    <StepLeftWrapper
      title={t.onboarding.profileStep.title}
      currentStep={currentStep}
      totalSteps={totalSteps}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canContinue) onNext();
        }}
        className="space-y-6 py-4"
      >
        <FileInput
          label={t.onboarding.profileStep.profilePictureLabel}
          name="profilePicture"
          onChange={onProfilePictureChange}
          onRemove={onProfilePictureRemove}
          value={profilePicturePreview}
          canRemove={hasCustomProfilePicture}
          description={t.onboarding.profileStep.profilePictureDescription}
        />

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="firstName">{t.onboarding.profileStep.firstNameLabel}</Label>
            <Input
              id="firstName"
              value={formData.firstName}
              onChange={(e) => updateFormData('firstName', e.target.value)}
              placeholder="John"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="lastName">{t.onboarding.profileStep.lastNameLabel}</Label>
            <Input
              id="lastName"
              value={formData.lastName}
              onChange={(e) => updateFormData('lastName', e.target.value)}
              placeholder="Doe"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">{t.onboarding.profileStep.emailLabel}</Label>
            <Input
              id="email"
              value={email}
              disabled
              className="bg-muted"
            />
          </div>
        </div>

        <hr className="border-t" />

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">{t.onboarding.profileStep.productUpdatesLabel}</p>
            <p className="text-xs text-muted-foreground">
              {t.onboarding.profileStep.productUpdatesDescription}
            </p>
          </div>
          <Switch
            checked={formData.productUpdates}
            onCheckedChange={(checked) => updateFormData('productUpdates', checked)}
          />
        </div>

        <Button type="submit" disabled={!canContinue} className="w-full" data-testid="onboarding-continue-btn">
          {t.onboarding.profileStep.continue}
        </Button>
      </form>
    </StepLeftWrapper>
  );
}

// Step 2: Organization Content (left side only)
interface OrganizationStepContentProps {
  formData: OnboardingFormData;
  updateFormData: (field: keyof OnboardingFormData, value: string | boolean) => void;
  onNext: () => void;
  onBack: () => void;
  currentStep: number;
  totalSteps: number;
}

function OrganizationStepContent({
  formData,
  updateFormData,
  onNext,
  onBack,
  currentStep,
  totalSteps,
}: OrganizationStepContentProps) {
  const t = getTranslations('common');
  const [countryOpen, setCountryOpen] = React.useState(false);

  const canContinue =
    formData.organizationName.trim() &&
    formData.country &&
    formData.organizationSize &&
    formData.referralSource &&
    formData.region;

  const selectedCountry = COUNTRIES.find((c) => c.code === formData.country);

  const handleCountryChange = (countryCode: string) => {
    updateFormData('country', countryCode);
    // Auto-update region when country changes
    updateFormData('region', getDefaultRegionForCountry(countryCode));
  };

  return (
    <StepLeftWrapper
      title={t.onboarding.workspaceStep.title}
      currentStep={currentStep}
      totalSteps={totalSteps}
      goBack={onBack}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canContinue) onNext();
        }}
        className="space-y-6 py-4"
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="organizationName">{t.onboarding.workspaceStep.organizationNameLabel}</Label>
            <Input
              id="organizationName"
              value={formData.organizationName}
              onChange={(e) => updateFormData('organizationName', e.target.value)}
              placeholder="Acme Inc."
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="country">{t.onboarding.workspaceStep.countryLabel}</Label>
            <Popover open={countryOpen} onOpenChange={setCountryOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={countryOpen}
                  className="w-full justify-between font-normal"
                  data-testid="onboarding-country-combobox"
                >
                  {selectedCountry ? selectedCountry.name : t.onboarding.workspaceStep.selectCountry}
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-[var(--radix-popover-trigger-width)] p-0" align="start">
                <Command>
                  <CommandInput placeholder={t.onboarding.workspaceStep.searchCountry} />
                  <CommandList className="max-h-[200px] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-track]:bg-transparent">
                    <CommandEmpty>{t.onboarding.workspaceStep.noCountryFound}</CommandEmpty>
                    <CommandGroup>
                      {COUNTRIES.map((country) => (
                        <CommandItem
                          key={country.code}
                          value={country.name}
                          onSelect={() => {
                            handleCountryChange(country.code);
                            setCountryOpen(false);
                          }}
                          className="flex justify-between"
                        >
                          {country.name}
                          <Check
                            className={cn(
                              "h-4 w-4",
                              formData.country === country.code ? "opacity-100" : "opacity-0"
                            )}
                          />
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>

          <div className="space-y-2">
            <Label htmlFor="region">{t.onboarding.workspaceStep.regionLabel}</Label>
            <Select
              value={formData.region}
              onValueChange={(value) => updateFormData('region', value)}
            >
              <SelectTrigger id="region">
                <SelectValue placeholder={t.onboarding.workspaceStep.selectRegion} />
              </SelectTrigger>
              <SelectContent>
                {NEON_REGIONS.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.flag} {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="organizationSize">{t.onboarding.workspaceStep.organizationSizeLabel}</Label>
            <Select
              value={formData.organizationSize}
              onValueChange={(value) => updateFormData('organizationSize', value)}
            >
              <SelectTrigger id="organizationSize">
                <SelectValue placeholder={t.onboarding.workspaceStep.selectSize} />
              </SelectTrigger>
              <SelectContent>
                {ORGANIZATION_SIZES.map((size) => (
                  <SelectItem key={size.id} value={size.id}>
                    {size.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="referralSource">{t.onboarding.workspaceStep.referralSourceLabel}</Label>
            <Input
              id="referralSource"
              value={formData.referralSource}
              onChange={(e) => updateFormData('referralSource', e.target.value)}
              placeholder={t.onboarding.workspaceStep.referralSourcePlaceholder}
            />
          </div>
        </div>

        <Button type="submit" disabled={!canContinue} className="w-full" data-testid="onboarding-continue-btn">
          {t.onboarding.workspaceStep.continue}
        </Button>
      </form>
    </StepLeftWrapper>
  );
}

// Step 3: Role Content (left side only)
interface RoleStepContentProps {
  formData: OnboardingFormData;
  updateFormData: (field: keyof OnboardingFormData, value: string | boolean) => void;
  onNext: () => void;
  onBack: () => void;
  currentStep: number;
  totalSteps: number;
}

function RoleStepContent({
  formData,
  updateFormData,
  onNext,
  onBack,
  currentStep,
  totalSteps,
}: RoleStepContentProps) {
  const t = getTranslations('common');
  const canContinue = !!formData.role;

  return (
    <StepLeftWrapper
      title={t.onboarding.roleStep.title}
      currentStep={currentStep}
      totalSteps={totalSteps}
      goBack={onBack}
    >
      <div className="flex h-full flex-col justify-between pb-4">
        <div className="space-y-6">
          <div className="space-y-2 -mt-2">
            <p className="text-sm">
              {t.onboarding.roleStep.intro1}
            </p>
            <p className="text-sm">
              {t.onboarding.roleStep.intro2}
            </p>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">{t.onboarding.roleStep.roleQuestion}</p>
            <div className="flex flex-wrap items-center gap-2">
              {ROLES.map((role) => (
                <div
                  key={role.id}
                  role="button"
                  data-testid="onboarding-role-btn"
                  className={cn(
                    'cursor-pointer rounded-lg border px-3 py-2 text-sm transition-colors',
                    formData.role === role.id
                      ? 'border-primary bg-primary/5'
                      : 'hover:bg-muted/50'
                  )}
                  onClick={() => updateFormData('role', role.id)}
                >
                  {role.label}
                </div>
              ))}
            </div>
          </div>
        </div>

        <Button
          onClick={onNext}
          disabled={!canContinue}
          className="w-full mt-8"
          data-testid="onboarding-continue-btn"
        >
          {t.onboarding.roleStep.continue}
        </Button>
      </div>
    </StepLeftWrapper>
  );
}

// Step 4: Apps Content (left side only)
interface AppsStepContentProps {
  availableApps: AppDefinition[];
  selectedApps: string[];
  toggleApp: (appCode: string) => void;
  onSubmit: () => void;
  onBack: () => void;
  currentStep: number;
  totalSteps: number;
  isSubmitting: boolean;
}

function OnboardingAppIcon({ app, className }: { app: AppDefinition; className?: string }) {
  const iconPath = getAppIcon(app.code);
  if (iconPath) {
    return <img src={iconPath} alt={app.name} className={className} />;
  }
  return <DynamicIcon name={app.icon} className={className} />;
}

function AppsStepContent({
  availableApps,
  selectedApps,
  toggleApp,
  onSubmit,
  onBack,
  currentStep,
  totalSteps,
  isSubmitting,
}: AppsStepContentProps) {
  const t = getTranslations('common');
  const visibleApps = availableApps.filter((app) => !isHiddenFromOnboarding(app.code));

  // Group apps by category
  const appsByCategory = visibleApps.reduce((acc, app) => {
    if (!acc[app.category]) {
      acc[app.category] = [];
    }
    acc[app.category].push(app);
    return acc;
  }, {} as Record<string, AppDefinition[]>);

  return (
    <StepLeftWrapper
      title={t.onboarding.appsStep.title}
      currentStep={currentStep}
      totalSteps={totalSteps}
      goBack={onBack}
    >
      <div className="flex h-full flex-col justify-between pb-4">
        <div className="space-y-6">
          <p className="text-sm -mt-2">
            {t.onboarding.appsStep.description}
          </p>

          <div className="flex flex-wrap items-center gap-2 max-h-[400px] overflow-y-auto">
            {visibleApps.map((app) => (
              <div
                key={app.code}
                role="button"
                data-testid="onboarding-app-btn"
                onClick={() => toggleApp(app.code)}
                className={cn(
                  'cursor-pointer rounded-lg border px-3 py-2 text-sm transition-colors flex items-center gap-2',
                  selectedApps.includes(app.code)
                    ? 'border-primary bg-primary/5'
                    : 'hover:bg-muted/50'
                )}
              >
                <OnboardingAppIcon app={app} className="size-4" />
                {getAppShortName(app.code, app.name)}
              </div>
            ))}
          </div>

          {selectedApps.length > 0 && (
            <p className="text-xs text-muted-foreground font-mono">
              {selectedApps.length === 1
                ? t.onboarding.appsStep.appsSelected.replace('{count}', '1')
                : t.onboarding.appsStep.appsSelectedPlural.replace('{count}', String(selectedApps.length))}
            </p>
          )}
        </div>

        <Button
          onClick={onSubmit}
          disabled={isSubmitting || selectedApps.length === 0}
          className="w-full mt-8"
          data-testid="onboarding-get-started-btn"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="mr-0.5 h-4 w-4 animate-spin" />
              {t.onboarding.appsStep.settingUp}
            </>
          ) : (
            t.onboarding.appsStep.getStarted
          )}
        </Button>
      </div>
    </StepLeftWrapper>
  );
}
