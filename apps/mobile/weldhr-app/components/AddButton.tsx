/**
 * The round "+" floating above the tab bar on every tab but Home, and the
 * card it morphs into (ComposeMenu, the same as WeldChat's): ask for a shift,
 * report sick (or better) and a new expense, with requesting time off as the
 * wide button underneath. Time off and expenses follow the workspace's
 * switches. Each tab keeps to what it is about: on Absence only time off and
 * reporting sick; on Expenses the receipt (upload one, or take a photo of it
 * as the wide button, each starting a new expense with it attached); on
 * Schedule a shift request and on Announcements, for people who may post
 * them, a new announcement, straight away without the card. The tab layout
 * renders it once, so it stays put while the tabs change; pushed screens and
 * forms open over it. Only for a member linked to an employee, since
 * everything in the menu is their own.
 */

import { useCallback, useRef, useState } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePathname, useRouter, type Href } from 'expo-router';
import { CalendarClock, CalendarPlus, Camera, Images, Receipt, Thermometer, type LucideIcon } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { ComposeMenu, type ComposeMenuItem } from '@/components/ComposeMenu';
import { useSelfState, type LinkedSelf } from '@/components/MyHrGate';
import { floatingButtonBottom } from '@/components/Screen';
import { useAbsences, useHrAccess } from '@/hooks/use-weldhr-queries';
import type { HrAccess } from '@/lib/access';
import { useI18n } from '@/lib/i18n';
import type { Translations } from '@/lib/i18n/locales/en';

interface Action {
  Icon: LucideIcon;
  title: string;
  href: Href;
  testID: string;
}

export function AddButton() {
  const state = useSelfState();
  const pathname = usePathname();
  // Not on Home: each tab's "+" adds what that tab is about.
  if (state.status !== 'ready' || pathname === '/') return null;
  return <AddMenu self={state.self} />;
}

function AddMenu({ self }: Readonly<{ self: LinkedSelf }>) {
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  const { colors } = useTheme();
  const router = useRouter();
  const pathname = usePathname();
  const { access } = useHrAccess();
  const absences = useAbsences();
  const sick = absences.data?.current != null;
  const [open, setOpen] = useState(false);
  // Pushed once the card's Modal is gone, or the screen would open under it.
  const pendingHrefRef = useRef<Href | null>(null);

  const go = (href: Href) => {
    pendingHrefRef.current = href;
    setOpen(false);
  };
  const flushPendingHref = useCallback(() => {
    const href = pendingHrefRef.current;
    pendingHrefRef.current = null;
    if (href) router.push(href);
  }, [router]);

  const { main, entries } = menuFor(pathname, self, sick, t);
  const items: ComposeMenuItem[] = entries.map(({ key, action: { Icon, title, href, testID }, hint }) => ({
    key,
    icon: <Icon size={20} color={colors.text} strokeWidth={1.9} />,
    title,
    hint,
    onPress: () => go(href),
    testID,
  }));
  const direct = directFor(pathname, access, t);
  // The button sits in the tab layout, which fills the screen: both edges are the same.
  const bottom = floatingButtonBottom(insets.bottom);

  return (
    <ComposeMenu
      open={open}
      onOpen={direct ? () => router.push(direct.href) : () => setOpen(true)}
      bottom={bottom}
      buttonBottom={bottom}
      buttonLabel={direct?.label ?? t.home.add}
      buttonTestID="tab-add"
      items={items}
      primary={{
        icon: <main.Icon size={20} color={colors.background} strokeWidth={2.1} />,
        label: main.title,
        onPress: () => go(main.href),
        testID: main.testID,
      }}
      onRequestClose={() => setOpen(false)}
      onClosed={flushPendingHref}
    />
  );
}

interface MenuEntry {
  key: string;
  action: Action;
  hint: string;
}

/** What the card offers on a tab: the wide button and the rows above it. */
function menuFor(pathname: string, self: LinkedSelf, sick: boolean, t: Translations): { main: Action; entries: MenuEntry[] } {
  // On Expenses it is about the receipt.
  if (pathname === '/expenses' && self.features.declarations) {
    return {
      main: {
        Icon: Camera,
        title: t.home.photoReceipt,
        href: { pathname: '/expense/new', params: { receipt: 'camera' } },
        testID: 'add-receipt-photo',
      },
      entries: [
        {
          key: 'upload',
          action: {
            Icon: Images,
            title: t.home.uploadReceipt,
            href: { pathname: '/expense/new', params: { receipt: 'library' } },
            testID: 'add-receipt-upload',
          },
          hint: t.home.uploadReceiptHint,
        },
      ],
    };
  }

  // On Absence only what is about being away: time off and reporting sick.
  const onAbsence = pathname === '/absence';
  const shift: Action = { Icon: CalendarClock, title: t.home.requestShift, href: '/shift/new', testID: 'add-shift' };
  const report: Action = {
    Icon: Thermometer,
    title: sick ? t.home.imBetter : t.home.reportSick,
    href: '/sick',
    testID: 'add-sick',
  };
  const leave: Action | null = self.features.leaveRequests
    ? { Icon: CalendarPlus, title: t.home.requestTimeOff, href: '/leave/new', testID: 'add-leave' }
    : null;
  // Time off is the main action; where the workspace has no leave requests,
  // asking for a shift (on Absence, reporting sick) takes its place.
  const fallback = onAbsence ? report : shift;
  const main = leave ?? fallback;

  const entries: MenuEntry[] = [];
  if (leave && !onAbsence) entries.push({ key: 'shift', action: shift, hint: t.home.requestShiftHint });
  if (main !== report) entries.push({ key: 'sick', action: report, hint: sick ? t.home.imBetterHint : t.home.reportSickHint });
  if (self.features.declarations && !onAbsence) {
    entries.push({
      key: 'expense',
      action: { Icon: Receipt, title: t.home.newExpense, href: '/expense/new', testID: 'add-expense' },
      hint: t.home.newExpenseHint,
    });
  }
  return { main, entries };
}

/** Where a tab has one thing to do, the "+" does it without the card: posting an announcement, asking for a shift. */
function directFor(pathname: string, access: HrAccess, t: Translations): { href: Href; label: string } | null {
  if (pathname === '/announcements' && access.createAnnouncements) {
    return { href: '/announcement/new', label: t.announcementForm.title };
  }
  if (pathname === '/schedule') return { href: '/shift/new', label: t.home.requestShift };
  return null;
}
