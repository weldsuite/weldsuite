
import { useState, useEffect, useRef } from 'react';
import { useNavigate, useBlocker } from '@tanstack/react-router';
import { useI18n } from '@/lib/i18n/provider';
import { Trans } from '@/lib/i18n/trans';
import { ChevronLeft, X, Clock, Link2, Globe, CalendarClock, AlertTriangle, Settings2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import { PageTabs } from '@weldsuite/ui/components/page-tabs';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@weldsuite/ui/components/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { useParams } from '@/lib/router';
import { useUser, useOrganization } from '@clerk/clerk-react';
import { useBookingPage, useUpdateBookingPage, useCreateBookingPage, type BookingPage, type BookingQuestion } from '@/hooks/queries/use-calendar-queries';
import { getBookingPortalUrl } from '@/lib/weldcalendar/booking-portal-url';
import { useSetAtom } from 'jotai';
import { draftBookingPageTitleAtom } from '../../lib/draft-booking-page';
import { LOCATION_TYPE_OPTIONS } from '../../types';
import { toast } from 'sonner';
import { getTranslations } from '@/lib/i18n';

type BookingFormError = 'errorAddressRequired' | 'errorSlugEmpty';

type CustomFieldType = BookingQuestion['type'];

interface CustomField {
  id: string;
  label: string;
  required: boolean;
  type: CustomFieldType;
  options?: string[];
}

/** Stable id of the built-in phone number field (it is a plain text question). */
const PHONE_FIELD_ID = 'phone';

const createCustomField = (
  label: string,
  required: boolean,
  type: CustomFieldType = 'text',
  options?: string[],
): CustomField => ({
  id: crypto.randomUUID(),
  label,
  required,
  type,
  ...(type === 'select' && options ? { options } : {}),
});

/** Editor fields -> the `questions` column the public booking form renders. */
function toQuestions(fields: CustomField[]): BookingQuestion[] {
  return fields.map((field) => ({
    id: field.id,
    label: field.label,
    type: field.type,
    required: field.required,
    ...(field.type === 'select' && field.options ? { options: field.options } : {}),
  }));
}

function fromQuestions(questions: BookingQuestion[] | null | undefined): CustomField[] {
  return (questions ?? []).map((q) => ({
    id: q.id,
    label: q.label,
    required: q.required,
    type: q.type,
    ...(q.type === 'select' && q.options ? { options: q.options } : {}),
  }));
}

/** One option per line; blank lines and duplicates dropped. */
const parseOptions = (raw: string): string[] =>
  Array.from(new Set(raw.split('\n').map((line) => line.trim()).filter(Boolean)));

const sanitizeSlug = (raw: string) =>
  raw
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, '-')
    .replaceAll(/-+/g, '-')
    .replaceAll(/^-|-$/g, '')
    .slice(0, 100);

const isSameValue = (current: string, stored: string | null | undefined, fallback = '') =>
  current === (stored || fallback);

/**
 * The location columns for the API. The meeting link / address only means
 * something for a video or in-person page, so it is dropped otherwise. On an
 * update an empty value is sent as `null`: PATCH skips `undefined`, so a
 * cleared link (= "create a WeldMeet link automatically") would otherwise never
 * be saved.
 */
function resolveLocationFields(locationType: string, locationValue: string) {
  const hasValue = (locationType === 'video' || locationType === 'in-person') && locationValue.trim() !== '';
  return {
    locationType: (locationType || null) as BookingPage['locationType'],
    locationValue: hasValue ? locationValue.trim() : null,
  };
}

/** Returns the i18n key of the first validation error, or null when the form can be saved. */
function getBookingFormError(locationType: string, locationValue: string, slug: string): BookingFormError | null {
  if (locationType === 'in-person' && !locationValue.trim()) return 'errorAddressRequired';
  if (!sanitizeSlug(slug)) return 'errorSlugEmpty';
  return null;
}

function readSessionJson<T>(key: string, fallback: T): T {
  const raw = sessionStorage.getItem(key);
  return raw ? JSON.parse(raw) : fallback;
}

function loadDraftStub(): Partial<BookingPage> {
  try {
    return JSON.parse(sessionStorage.getItem('booking-new-draft') || '{}');
  } catch {
    return {};
  }
}

// Treat a stored 'UTC' as "never explicitly set" — old records were created
// before the editor sent a timezone and defaulted to UTC server-side, which
// makes the booking-portal mis-interpret wall-clock hours.
const resolveTimezone = (stored: string | undefined, browserTz: string) =>
  stored && stored !== 'UTC' ? stored : browserTz;

function listTimezones(browserTz: string): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf: (key: string) => string[] }).supportedValuesOf('timeZone');
  } catch {
    return ['UTC', browserTz];
  }
}

const LOCATION_LABEL_KEYS = {
  video: 'locationWeldMeet',
  phone: 'locationPhoneCall',
  'in-person': 'locationInPerson',
} as const;

const canSaveBookingForm = (locationType: string, locationValue: string, slug: string) =>
  !(locationType === 'in-person' && !locationValue.trim()) && slug.trim().length > 0;

const getBrowserTimezone = () =>
  typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';

interface SubmitLabelState {
  isDraft: boolean;
  isCreating: boolean;
  isSaving: boolean;
}

function getSubmitLabelKey({ isDraft, isCreating, isSaving }: SubmitLabelState) {
  if (isDraft) return isCreating ? 'creating' : 'create';
  return isSaving ? 'saving' : 'save';
}

function formatDuration(m: number) {
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r > 0 ? `${h}h ${r}m` : `${h}h`;
}

export default function BookingPageDetailPage() {
  const { id } = useParams<{ id: string }>();
  const isDraft = id === '__draft__';
  const navigate = useNavigate();
  const { t } = useI18n();
  const tc = getTranslations('weldcalendar');
  const { data, isLoading } = useBookingPage(isDraft ? '' : id);
  const updateBookingPage = useUpdateBookingPage();
  const createBookingPage = useCreateBookingPage();
  const { user } = useUser();
  const { organization } = useOrganization();
  // In draft mode the booking page doesn't exist yet — synthesise a stub from
  // the sessionStorage payload the editor's Continue button wrote so the
  // preview / hasUnsavedChanges / etc. don't crash on `bookingPage.X`.
  const [draftStub] = useState<Partial<BookingPage> | null>(() => (id === '__draft__' ? loadDraftStub() : null));
  const bookingPage = data?.data ?? draftStub;
  const orgSlug = organization?.slug || organization?.id || '';
  // Guests book through the public booking portal, never through the platform origin.
  const bookingPortalUrl = getBookingPortalUrl();
  const userName = user?.fullName || user?.firstName || 'User';
  const userAvatar = user?.imageUrl;

  const [discardDialogOpen, setDiscardDialogOpen] = useState(false);

  const hasUnsavedChanges = () => {
    if (!bookingPage) return false;
    return !(
      isSameValue(name, bookingPage.name) &&
      isSameValue(slug, bookingPage.slug) &&
      isSameValue(description, bookingPage.description) &&
      isSameValue(locationType, bookingPage.locationType) &&
      isSameValue(locationValue, bookingPage.locationValue) &&
      isSameValue(confirmationMessage, bookingPage.confirmationMessage) &&
      isSameValue(timezone, bookingPage.timezone, browserTz) &&
      JSON.stringify(toQuestions(customFields)) === JSON.stringify(bookingPage.questions ?? [])
    );
  };

  const handleNavigateBack = () => {
    if (isDraft) {
      // Draft mode: jump back to the editor (Schedule tab). The form data is
      // still in sessionStorage, so the editor can rehydrate if it ever needs
      // to. For now it just starts fresh — Continue again to re-save.
      navigate({ to: '/weldcalendar/scheduling/new' });
      return;
    }
    if (hasUnsavedChanges()) {
      setDiscardDialogOpen(true);
    } else {
      navigate({ to: '/weldcalendar/scheduling/$id/edit', params: { id } });
    }
  };

  // Settings state
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [locationType, setLocationType] = useState('');
  const [locationValue, setLocationValue] = useState('');
  const [confirmationMessage, setConfirmationMessage] = useState('');
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [addItemOpen, setAddItemOpen] = useState(false);
  const [addItemType, setAddItemType] = useState<'select' | 'phone' | 'custom'>('select');
  const [newItemLabel, setNewItemLabel] = useState('');
  const [newItemRequired, setNewItemRequired] = useState(false);
  const [newItemAnswerType, setNewItemAnswerType] = useState<CustomFieldType>('text');
  const [newItemOptions, setNewItemOptions] = useState('');
  const hasPhoneField = customFields.some((f) => f.id === PHONE_FIELD_ID);
  const newItemOptionList = parseOptions(newItemOptions);
  const canAddCustomItem =
    newItemLabel.trim().length > 0 && (newItemAnswerType !== 'select' || newItemOptionList.length > 0);

  const resetAddItem = () => {
    setAddItemType('select');
    setNewItemLabel('');
    setNewItemRequired(false);
    setNewItemAnswerType('text');
    setNewItemOptions('');
  };

  const addCustomItem = () => {
    setCustomFields((prev) => [
      ...prev,
      createCustomField(newItemLabel.trim(), newItemRequired, newItemAnswerType, newItemOptionList),
    ]);
    setAddItemOpen(false);
    resetAddItem();
  };

  const addPhoneItem = () => {
    setCustomFields((prev) => [
      ...prev,
      { id: PHONE_FIELD_ID, label: tc.bookingDetail.fieldPhoneNumber, required: true, type: 'text' },
    ]);
    setAddItemOpen(false);
    resetAddItem();
  };
  const browserTz = getBrowserTimezone();
  const [timezone, setTimezone] = useState(browserTz);
  const [tzOpen, setTzOpen] = useState(false);
  const [tzSearch, setTzSearch] = useState('');
  const tzSearchInputRef = useRef<HTMLInputElement>(null);

  const allTimezones = listTimezones(browserTz);

  const setDraftTitle = useSetAtom(draftBookingPageTitleAtom);

  // Keep the sidebar's draft entry name in sync with the live `name` field
  // while we're editing a not-yet-created booking page.
  useEffect(() => {
    if (!isDraft) return;
    setDraftTitle(name);
  }, [isDraft, name, setDraftTitle]);
  useEffect(() => {
    if (!isDraft) return;
    return () => setDraftTitle(null);
  }, [isDraft, setDraftTitle]);

  useEffect(() => {
    if (isDraft) {
      // Draft mode: read from sessionStorage instead of API. The editor's
      // Continue button stashes the Schedule-tab data here right before
      // navigating to this page.
      const draftRaw = sessionStorage.getItem('booking-new-draft');
      if (!draftRaw) return;
      try {
        const draft = JSON.parse(draftRaw);
        setName(draft.name || '');
        setSlug(draft.slug || '');
        setSlugTouched(false);
        setTimezone(resolveTimezone(draft.timezone, browserTz));
      } catch {
        // corrupt draft — ignore, fall back to empty form
      }
      return;
    }
    if (bookingPage) {
      // Check for pending changes from the first page
      const pending = readSessionJson<{ name?: string } | null>(`booking-edit-${id}`, null);

      setName(pending?.name || bookingPage.name || '');
      setSlug(bookingPage.slug || '');
      setSlugTouched(false);
      setDescription(bookingPage.description || '');
      setLocationType(bookingPage.locationType || '');
      setLocationValue(bookingPage.locationValue || '');
      setConfirmationMessage(bookingPage.confirmationMessage || '');
      setTimezone(resolveTimezone(bookingPage.timezone, browserTz));
      setCustomFields(fromQuestions(bookingPage.questions));
    }
  }, [bookingPage, id, isDraft, browserTz]);

  const canSave = canSaveBookingForm(locationType, locationValue, slug);

  // Create the draft booking page via API without navigating. Used by both
  // the explicit "Create" button (then navigates to /view) and the blocker's
  // "Save and leave" (then proceeds with the blocked navigation).
  const persistDraftCreate = async (): Promise<{ newId: string | null }> => {
    const cleanSlug = sanitizeSlug(slug);
    const draft = readSessionJson<Partial<BookingPage>>('booking-new-draft', {});
    const location = resolveLocationFields(locationType, locationValue);
    const result = await createBookingPage.mutateAsync({
      ...draft,
      name,
      slug: cleanSlug,
      description: description || undefined,
      locationType: location.locationType ?? undefined,
      locationValue: location.locationValue ?? undefined,
      confirmationMessage: confirmationMessage || undefined,
      timezone,
      questions: toQuestions(customFields),
    });
    sessionStorage.removeItem('booking-new-draft');
    const newId = result?.data?.id || null;
    return { newId };
  };

  const handleSave = async () => {
    if (!id) return;
    const formError = getBookingFormError(locationType, locationValue, slug);
    if (formError) {
      toast.error(tc.bookingDetail[formError]);
      return;
    }
    const cleanSlug = sanitizeSlug(slug);

    if (isDraft) {
      const { newId } = await persistDraftCreate();
      draftSavedRef.current = true;
      toast.success(tc.toast.bookingPageSaved);
      if (newId) {
        navigate({ to: '/weldcalendar/scheduling/$id/view', params: { id: newId } });
      } else {
        navigate({ to: '/weldcalendar' });
      }
      return;
    }

    // Merge any pending changes from the first page (availability, duration, etc.)
    const pending = readSessionJson<Partial<BookingPage>>(`booking-edit-${id}`, {});

    await updateBookingPage.mutateAsync({
      id,
      data: {
        ...pending,
        name,
        slug: cleanSlug,
        // '' (not undefined) is what clears a description / message that was removed.
        description,
        ...resolveLocationFields(locationType, locationValue),
        confirmationMessage,
        timezone,
        questions: toQuestions(customFields),
      },
    });
    sessionStorage.removeItem(`booking-edit-${id}`);
    toast.success(tc.toast.bookingPageSaved);
    navigate({ to: '/weldcalendar/scheduling/$id/view', params: { id } });
  };

  // Blocker (draft mode only). Mirrors the editor's behaviour: navigating
  // away with an uncreated booking page opens a dialog with Keep editing /
  // Discard / Save and leave.
  const draftSavedRef = useRef(false);
  const { proceed, reset, status } = useBlocker({
    shouldBlockFn: () => isDraft && !draftSavedRef.current && !createBookingPage.isPending,
    withResolver: true,
    enableBeforeUnload: () => isDraft && !draftSavedRef.current,
  });
  const blocked = status === 'blocked';

  const handleSaveAndProceed = async () => {
    if (!isDraft) return;
    const formError = getBookingFormError(locationType, locationValue, slug);
    if (formError) {
      toast.error(tc.bookingDetail[formError]);
      return;
    }
    try {
      await persistDraftCreate();
      draftSavedRef.current = true;
      proceed?.();
    } catch {
      // mutation already toasts; keep dialog open so the user can retry / discard
    }
  };

  const handleDiscardAndProceed = () => {
    sessionStorage.removeItem('booking-new-draft');
    draftSavedRef.current = true;
    proceed?.();
  };

  const locationLabelKey = LOCATION_LABEL_KEYS[locationType as keyof typeof LOCATION_LABEL_KEYS];
  const locationLabel = locationLabelKey ? tc.bookingDetail[locationLabelKey] : '';

  if (!isDraft && isLoading) return <div className="flex items-center justify-center py-12 text-muted-foreground">{tc.bookingDetail.loadingBookingPage}</div>;
  // In draft mode `bookingPage` is always the (possibly empty) draftStub object, never null.
  if (!bookingPage) return <div className="flex items-center justify-center py-12 text-muted-foreground">{tc.bookingDetail.bookingPageNotFound}</div>;

  return (
    <div className="flex flex-col h-full">
      {/* Shared header row */}
      <div className="flex items-center shrink-0 border-b">
        <div className="flex-1 flex items-center gap-3 px-4 py-2.5">
          <Button variant="outline" size="icon" className="h-8 w-8" onClick={handleNavigateBack}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <h2 className="text-base font-semibold tracking-tight">{name || bookingPage.name || tc.misc.defaultBookingPage}</h2>
        </div>
        <div className="w-[480px] shrink-0 border-l flex items-end h-full">
          <PageTabs
            tabs={[
              { id: 'schedule', label: tc.bookingEditor.tabSchedule, icon: CalendarClock },
              { id: 'details', label: tc.bookingEditor.tabDetails, icon: Settings2 },
            ]}
            activeTab="details"
            onTabChange={(tabId) => {
              if (tabId === 'schedule') {
                navigate({ to: '/weldcalendar/scheduling/$id/edit', params: { id } });
              }
            }}
            className="w-full [&>div:first-child]:hidden"
            innerClassName="px-4"
          />
          <Button
            variant="ghost"
            onClick={() => {
              if (hasUnsavedChanges()) {
                setDiscardDialogOpen(true);
              } else {
                navigate({ to: '/weldcalendar' });
              }
            }}
            className="self-center mr-5 p-1.5 hover:bg-muted rounded-md transition-colors h-auto"
            title={tc.bookingEditor.close}
          >
            <X className="h-4 w-4 text-gray-500" />
          </Button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
      {/* Left — Booking preview (exact booking-portal enter-details design) */}
      <div className="flex-1 flex items-center justify-center bg-gray-50 dark:bg-muted/20 overflow-auto p-8">
        <div className="bg-white dark:bg-background border border-gray-200 dark:border-border rounded-2xl overflow-hidden flex" style={{ minHeight: 535 }}>

          {/* Event Info Sidebar — exact booking-portal */}
          <div className="w-[280px] shrink-0 border-r border-gray-200 dark:border-border flex flex-col overflow-hidden">
            {/* Banner */}
            <div className="relative h-[90px] bg-gray-100 dark:bg-muted shrink-0">
              <div className="absolute -bottom-5 left-6">
                <div className="h-10 w-10 rounded-full bg-white dark:bg-background border-2 border-white dark:border-background overflow-hidden">
                  <div className="h-full w-full bg-gray-200 dark:bg-muted flex items-center justify-center text-sm font-semibold text-gray-500 dark:text-muted-foreground">
                    {(name || 'B').charAt(0).toUpperCase()}
                  </div>
                </div>
              </div>
            </div>

            {/* Content */}
            <div className="flex flex-col flex-1 px-6 pt-8 pb-6">
              <p className="text-sm font-medium text-gray-500 dark:text-muted-foreground mb-2">{userName}</p>
              <h1 className="text-[22px] font-bold text-gray-900 dark:text-foreground leading-tight mb-2">{name || bookingPage.name}</h1>
              {description && (
                <p className="text-[13px] text-gray-500 dark:text-muted-foreground leading-relaxed break-words whitespace-pre-wrap">{description}</p>
              )}
              <div className="space-y-3 text-sm text-gray-500 dark:text-muted-foreground mt-auto">
                <div className="flex items-center gap-2.5">
                  <Clock className="h-4 w-4 shrink-0" />
                  <span>{formatDuration(bookingPage.duration || 0)}</span>
                </div>
                {locationLabel && (
                  <div className="flex items-start gap-2.5">
                    <Link2 className="h-4 w-4 shrink-0 mt-0.5" />
                    <div>
                      <span>{locationLabel}</span>
                      {locationType === 'video' && locationValue && (
                        <p className="text-xs text-gray-400 dark:text-muted-foreground/60 mt-0.5 break-all">{locationValue}</p>
                      )}
                    </div>
                  </div>
                )}
                <Popover open={tzOpen} onOpenChange={setTzOpen}>
                  <PopoverTrigger asChild>
                    <Button variant="ghost" className="flex items-center gap-2.5 hover:text-gray-900 dark:hover:text-foreground transition-colors cursor-pointer -ml-2.5 -my-1.5 px-2.5 py-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-muted h-auto">
                      <Globe className="h-4 w-4 shrink-0" />
                      <span>{timezone}</span>
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    className="w-64 p-0"
                    align="start"
                    side="bottom"
                    onOpenAutoFocus={(e) => {
                      e.preventDefault();
                      tzSearchInputRef.current?.focus();
                    }}
                  >
                    <div className="border-b border-gray-200 dark:border-border">
                      <input
                        ref={tzSearchInputRef}
                        type="text"
                        placeholder={tc.bookingDetail.searchTimezonePlaceholder}
                        value={tzSearch}
                        onChange={(e) => setTzSearch(e.target.value)}
                        className="w-full px-3 py-2 text-sm outline-none bg-transparent"
                      />
                    </div>
                    <div className="max-h-60 overflow-y-auto p-1">
                      {allTimezones
                        .filter((item) => item.toLowerCase().includes(tzSearch.toLowerCase()))
                        .slice(0, 200)
                        .map((item) => (
                          <Button
                            key={item}
                            variant="ghost"
                            onClick={() => { setTimezone(item); setTzOpen(false); setTzSearch(''); }}
                            className={`w-full text-left px-2 py-1.5 text-sm rounded-sm transition-colors h-auto justify-start ${
                              item === timezone ? 'bg-gray-100 dark:bg-muted font-medium text-gray-900 dark:text-foreground' : 'text-gray-700 dark:text-muted-foreground hover:bg-gray-50 dark:hover:bg-muted/50'
                            }`}
                          >
                            {item}
                          </Button>
                        ))}
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
            </div>
          </div>

          {/* Form — exact booking-portal enter-details */}
          <div className="p-6 flex flex-col" style={{ width: 480 }}>
            <div className="space-y-4 flex-1">
              <div className="space-y-2">
                <Label className="text-sm font-semibold">
                  {tc.bookingDetail.yourName} <span className="text-destructive">*</span>
                </Label>
                <Input placeholder={tc.bookingDetail.yourNamePlaceholder} className="shadow-none" disabled />
              </div>

              <div className="space-y-2">
                <Label className="text-sm font-semibold">
                  {tc.bookingDetail.emailAddress} <span className="text-destructive">*</span>
                </Label>
                <Input type="email" placeholder={tc.bookingDetail.emailPlaceholder} className="shadow-none" disabled />
              </div>

              {/* Custom fields */}
              {customFields.map((field) => (
                <div key={field.id} className="space-y-2">
                  <Label className="text-sm font-semibold">
                    {field.label} {field.required && <span className="text-destructive">*</span>}
                  </Label>
                  {field.type === 'textarea' && (
                    <Textarea placeholder={field.label} className="min-h-[80px] shadow-none" disabled />
                  )}
                  {field.type === 'select' && (
                    <Select disabled>
                      <SelectTrigger className="w-full shadow-none">
                        <SelectValue placeholder={tc.bookingDetail.fieldSelectPlaceholder} />
                      </SelectTrigger>
                      <SelectContent>
                        {(field.options ?? []).map((option) => (
                          <SelectItem key={option} value={option}>{option}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {field.type === 'text' && (
                    <Input placeholder={field.label} className="shadow-none" disabled />
                  )}
                </div>
              ))}

              <div className="space-y-2">
                <Label className="text-sm font-semibold">{tc.bookingDetail.additionalNotesLabel}</Label>
                <Textarea
                  placeholder={tc.bookingDetail.additionalNotesPlaceholder}
                  className="min-h-[100px] shadow-none"
                  disabled
                />
              </div>

              <div className="space-y-2">
                <Label className="text-sm font-semibold">{tc.bookingDetail.guestsLabel}</Label>
                <div className="flex gap-2">
                  <Input type="email" placeholder={tc.bookingDetail.guestsPlaceholder} className="shadow-none" disabled />
                  <Button type="button" variant="outline" className="shrink-0 shadow-none h-9" disabled>
                    {tc.bookingDetail.guestsAdd}
                  </Button>
                </div>
              </div>
            </div>

            <div className="h-px bg-gray-100 dark:bg-border my-4" />

            <div>
              <p className="text-xs text-muted-foreground mb-4">
                <Trans
                  template={t.common.legal.termsAndPrivacyNotice}
                  values={{
                    terms: <strong className="text-foreground font-semibold">{t.common.legal.terms}</strong>,
                    privacy: <strong className="text-foreground font-semibold">{t.common.legal.privacyPolicy}</strong>,
                  }}
                />
              </p>
              <div className="flex items-center justify-end gap-2">
                <Button type="button" variant="outline" className="shadow-none" disabled>
                  {tc.bookingDetail.back}
                </Button>
                <Button disabled>
                  {tc.bookingDetail.confirm}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Right — Settings */}
      <div className="w-[480px] shrink-0 border-l flex flex-col bg-background">
        <div className="flex-1 overflow-y-auto">
          <div className="divide-y">
            {/* Booking page photo and name */}
            <div className="px-5 py-4 space-y-3">
              <div>
                <p className="text-sm font-medium">{tc.bookingDetail.bookingPagePhotoName}</p>
                <p className="text-xs text-muted-foreground">{tc.bookingDetail.bookingPagePhotoNameHint}</p>
              </div>
              <div className="flex items-center gap-2">
                {userAvatar ? (
                  <img src={userAvatar} alt={userName} className="h-6 w-6 rounded-[7px] object-cover shrink-0" />
                ) : (
                  <div className="h-6 w-6 rounded-[7px] bg-primary/80 flex items-center justify-center text-[10px] font-semibold text-primary-foreground shrink-0">
                    {userName.charAt(0).toUpperCase()}
                  </div>
                )}
                <p className="text-sm font-medium">{userName}</p>
              </div>
              <p className="text-xs text-muted-foreground">
                {tc.bookingDetail.identityNote}{' '}
                <Button variant="link" className="text-primary hover:underline h-auto p-0 text-xs">{tc.bookingDetail.manageAccountPhotoName}</Button>
              </p>
            </div>

            {/* Booking page name */}
            <div className="px-5 py-4 space-y-2">
              <Label>{tc.bookingDetail.bookingPageNameLabel}</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={tc.bookingDetail.bookingPageNamePlaceholder} />
            </div>

            {/* Booking link / slug */}
            <div className="px-5 py-4 space-y-2">
              <div>
                <p className="text-sm font-medium">{tc.bookingDetail.bookingLinkTitle}</p>
                <p className="text-xs text-muted-foreground">{tc.bookingDetail.bookingLinkHint}</p>
              </div>
              <div className="flex items-stretch rounded-md border border-input bg-background overflow-hidden focus-within:ring-1 focus-within:ring-ring">
                <span className="flex items-center px-3 text-xs text-muted-foreground bg-muted/50 border-r border-input select-none truncate max-w-[60%]">
                  {bookingPortalUrl.replace(/^https?:\/\//, '')}/{orgSlug}/
                </span>
                <input
                  value={slug}
                  onChange={(e) => { setSlug(e.target.value); setSlugTouched(true); }}
                  onBlur={() => setSlug((s) => sanitizeSlug(s))}
                  placeholder={tc.bookingDetail.bookingLinkPlaceholder}
                  className="flex-1 min-w-0 px-3 py-1.5 text-sm bg-transparent outline-none"
                />
              </div>
              {slugTouched && slug.length > 0 && slug !== sanitizeSlug(slug) && (
                <p className="text-[11px] text-muted-foreground">
                  {tc.bookingDetail.slugSavedAs} <span className="font-mono">{sanitizeSlug(slug)}</span>
                </p>
              )}
              {slugTouched && !slug.trim() && (
                <p className="text-[11px] text-destructive">{tc.bookingDetail.slugRequired}</p>
              )}
              {bookingPage.slug && sanitizeSlug(slug) && sanitizeSlug(slug) !== bookingPage.slug && (
                <div className="flex gap-2 rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-950/30 px-3 py-2 text-[12px] text-amber-900 dark:text-amber-200">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <p className="font-medium">{tc.bookingDetail.urlWillChange}</p>
                    <p className="text-amber-800/90 dark:text-amber-200/80">
                      {tc.bookingDetail.urlWillChangeWarning.replace('{oldSlug}', `/${orgSlug}/${bookingPage.slug}`)}
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Location and conferencing */}
            <div className="px-5 py-4 space-y-3">
              <div>
                <p className="text-sm font-medium">{tc.bookingDetail.locationTitle}</p>
                <p className="text-xs text-muted-foreground">{tc.bookingDetail.locationHint}</p>
              </div>
              <Select value={locationType || 'none'} onValueChange={(v) => setLocationType(v === 'none' ? '' : v)}>
                <SelectTrigger><SelectValue placeholder={tc.bookingDetail.locationTitle} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{tc.bookingDetail.locationNoLocation}</SelectItem>
                  {LOCATION_TYPE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {locationType === 'video' && (
                <div className="space-y-2">
                  <Label htmlFor="booking-meeting-link">{tc.bookingDetail.locationMeetingLinkLabel}</Label>
                  <Input
                    id="booking-meeting-link"
                    type="url"
                    value={locationValue}
                    onChange={(e) => setLocationValue(e.target.value)}
                    placeholder={tc.bookingDetail.locationMeetingLinkPlaceholder}
                  />
                  <p className="text-xs text-muted-foreground">
                    {locationValue.trim()
                      ? tc.bookingDetail.locationMeetingLinkCustomHint
                      : tc.bookingDetail.locationMeetingLinkHint}
                  </p>
                </div>
              )}
              {locationType === 'phone' && (
                <p className="text-xs text-muted-foreground">{tc.bookingDetail.locationPhoneHint}</p>
              )}
              {locationType === 'in-person' && (
                <div className="space-y-2">
                  <Label>{tc.bookingDetail.locationAddressLabel}</Label>
                  <Input
                    value={locationValue}
                    onChange={(e) => setLocationValue(e.target.value)}
                    placeholder="123 Main St, City"
                  />
                  {!locationValue.trim() && (
                    <p className="text-xs text-muted-foreground">{tc.bookingDetail.locationAddressHint}</p>
                  )}
                </div>
              )}
            </div>

            {/* Description */}
            <div className="px-5 py-4 space-y-3">
              <div>
                <p className="text-sm font-medium">{tc.bookingDetail.descriptionTitle}</p>
                <p className="text-xs text-muted-foreground">{tc.bookingDetail.descriptionHint}</p>
              </div>
              <Textarea value={description} onChange={(e) => setDescription(e.target.value.slice(0, 300))} placeholder={tc.bookingDetail.descriptionPlaceholder} rows={3} maxLength={300} />
              <p className="text-[11px] text-muted-foreground text-right">{description.length}/300</p>
            </div>

            {/* Booking form */}
            <div className="px-5 py-4 space-y-3">
              <div>
                <p className="text-sm font-medium">{tc.bookingDetail.bookingFormTitle}</p>
                <p className="text-xs text-muted-foreground">{tc.bookingDetail.bookingFormHint}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <span className="inline-flex items-center px-3 py-1.5 text-sm border rounded-md bg-muted/30">
                  {tc.bookingDetail.yourName}<span className="text-destructive ml-0.5">*</span>
                </span>
                <span className="inline-flex items-center px-3 py-1.5 text-sm border rounded-md bg-muted/30">
                  {tc.bookingDetail.fieldEmail}<span className="text-destructive ml-0.5">*</span>
                </span>
                {customFields.map((field) => (
                  <span key={field.id} className="inline-flex items-center gap-1 px-3 py-1.5 text-sm border rounded-md bg-muted/30">
                    {field.label}{field.required && <span className="text-destructive">*</span>}
                    <Button
                      variant="ghost"
                      onClick={() => setCustomFields((prev) => prev.filter((f) => f.id !== field.id))}
                      className="ml-1 text-muted-foreground hover:text-destructive transition-colors h-auto p-0"
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </span>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">{tc.bookingDetail.fieldRequired}</p>
              <Button variant="outline" onClick={() => { setAddItemType(hasPhoneField ? 'custom' : 'select'); setAddItemOpen(true); }}>
                {tc.bookingDetail.addItem}
              </Button>

              <Dialog open={addItemOpen} onOpenChange={(open) => { setAddItemOpen(open); if (!open) resetAddItem(); }}>
                <DialogContent className="sm:max-w-[400px]">
                  <DialogHeader>
                    <DialogTitle>{tc.bookingDetail.addFormField}</DialogTitle>
                  </DialogHeader>

                  <div className="space-y-4 py-2">
                    <div className="space-y-2">
                      <Label>{tc.bookingDetail.fieldTypeLabel}</Label>
                      <Select
                        value={addItemType === 'custom' || hasPhoneField ? 'custom' : 'phone'}
                        onValueChange={(v) => {
                          if (v === 'phone') {
                            setAddItemType('select');
                            setNewItemLabel(tc.bookingDetail.fieldPhoneNumber);
                            setNewItemRequired(true);
                          } else {
                            setAddItemType('custom');
                            setNewItemLabel('');
                            setNewItemRequired(false);
                          }
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {!hasPhoneField && (
                            <SelectItem value="phone">{tc.bookingDetail.fieldPhoneNumber}</SelectItem>
                          )}
                          <SelectItem value="custom">{tc.bookingDetail.fieldCustom}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {addItemType === 'custom' && (
                      <div className="space-y-2">
                        <Label>{tc.bookingDetail.fieldLabelLabel}</Label>
                        <Input
                          value={newItemLabel}
                          onChange={(e) => setNewItemLabel(e.target.value)}
                          placeholder={tc.bookingDetail.fieldLabelPlaceholder}
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && canAddCustomItem) addCustomItem();
                          }}
                        />
                      </div>
                    )}

                    {addItemType === 'custom' && (
                      <div className="space-y-2">
                        <Label>{tc.bookingDetail.fieldAnswerTypeLabel}</Label>
                        <Select value={newItemAnswerType} onValueChange={(v) => setNewItemAnswerType(v as CustomFieldType)}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="text">{tc.bookingDetail.fieldAnswerTypeText}</SelectItem>
                            <SelectItem value="textarea">{tc.bookingDetail.fieldAnswerTypeTextarea}</SelectItem>
                            <SelectItem value="select">{tc.bookingDetail.fieldAnswerTypeSelect}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    )}

                    {addItemType === 'custom' && newItemAnswerType === 'select' && (
                      <div className="space-y-2">
                        <Label>{tc.bookingDetail.fieldOptionsLabel}</Label>
                        <Textarea
                          value={newItemOptions}
                          onChange={(e) => setNewItemOptions(e.target.value)}
                          placeholder={tc.bookingDetail.fieldOptionsPlaceholder}
                          rows={4}
                        />
                        {newItemOptionList.length === 0 && (
                          <p className="text-xs text-muted-foreground">{tc.bookingDetail.fieldOptionsHint}</p>
                        )}
                      </div>
                    )}

                    <div className="flex items-center justify-between">
                      <Label className="text-sm font-normal">{tc.bookingDetail.requiredField}</Label>
                      <Switch
                        checked={addItemType === 'custom' ? newItemRequired : true}
                        onCheckedChange={addItemType === 'custom' ? setNewItemRequired : undefined}
                        disabled={addItemType !== 'custom'}
                        className="[&_[data-slot=switch-thumb]]:translate-y-[0.5px]"
                      />
                    </div>
                  </div>

                  <DialogFooter>
                    <Button variant="outline" onClick={() => { setAddItemOpen(false); resetAddItem(); }}>{tc.bookingDetail.cancelButton}</Button>
                    <Button
                      disabled={addItemType === 'custom' && !canAddCustomItem}
                      onClick={() => {
                        if (addItemType === 'custom') addCustomItem();
                        else addPhoneItem();
                      }}
                    >
                      {tc.bookingDetail.addButton}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </div>
        </div>

        <div className="border-t px-5 py-3 flex items-center justify-between shrink-0">
          <Button variant="outline" onClick={handleNavigateBack}>{tc.bookingDetail.back}</Button>
          <Button onClick={handleSave} disabled={updateBookingPage.isPending || createBookingPage.isPending || !canSave}>
            {tc.bookingDetail[getSubmitLabelKey({
              isDraft,
              isCreating: createBookingPage.isPending,
              isSaving: updateBookingPage.isPending,
            })]}
          </Button>
        </div>
      </div>
      </div>

      <Dialog open={discardDialogOpen} onOpenChange={setDiscardDialogOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>{tc.bookingDetail.discardTitle}</DialogTitle>
            <DialogDescription>
              {tc.bookingDetail.discardDescription}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDiscardDialogOpen(false)}>
              {tc.bookingDetail.keepEditing}
            </Button>
            <Button variant="destructive" onClick={() => navigate({ to: '/weldcalendar/scheduling/$id/edit', params: { id } })}>
              {tc.bookingDetail.discard}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Draft-mode navigation blocker dialog */}
      <Dialog
        open={blocked}
        onOpenChange={(open) => {
          if (!open && reset) reset();
        }}
      >
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>{tc.bookingEditor.discardChangesTitle}</DialogTitle>
            <DialogDescription>
              {tc.bookingEditor.discardChangesDescription}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={handleDiscardAndProceed} disabled={createBookingPage.isPending}>
              {tc.bookingEditor.discard}
            </Button>
            <Button onClick={handleSaveAndProceed} disabled={createBookingPage.isPending}>
              {createBookingPage.isPending ? tc.bookingEditor.saving : tc.bookingDetail.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
