/**
 * Five tabs: Home, Schedule (planned and worked hours per week, with the open
 * shifts to sign up for), Absence, Expenses and Announcements (what HR
 * posted, the unread count on the tab). Each opens on the member's own view and adds the team's views for
 * people with the permission (see lib/access.ts). Payslips, tasks, reviews, the directory and settings
 * live on the profile page, opened from the workspace menu at the top of Home.
 * The floating tab bar is the same chrome as the other WeldSuite apps; the
 * round "+" above it (AddButton) is on every tab.
 */

import type { ComponentProps } from 'react';
import { Tabs } from 'expo-router';
import { StyleSheet, View, type ColorValue } from 'react-native';
import { CalendarDays, CalendarHeart, House, Megaphone, Receipt } from 'lucide-react-native';
import {
  FloatingTabBar,
  floatingTabBarScreenOptions,
  type FloatingTabBarProps,
} from '@weldsuite/mobile-ui/components/FloatingTabBar';

import { AddButton } from '@/components/AddButton';
import { BRAND } from '@/constants/brand';
import { usePalette } from '@/hooks/use-palette';
import { useAnnouncements, useHrAccess, usePendingExpenses, usePendingLeave } from '@/hooks/use-weldhr-queries';
import { useI18n } from '@/lib/i18n';

type TabIconProps = { color: ColorValue; size: number };
type TabBarRenderProps = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0];

/** Solid, so the content scrolling underneath does not show through the floating island. */
function WeldHrTabBar(props: Readonly<FloatingTabBarProps>) {
  const palette = usePalette();
  return <FloatingTabBar {...props} badgeColor={BRAND} shellColor={palette.surface} />;
}

function renderTabBar(props: TabBarRenderProps) {
  return <WeldHrTabBar {...(props as unknown as FloatingTabBarProps)} />;
}

const HomeIcon = ({ color, size }: TabIconProps) => <House size={size} color={color} strokeWidth={2.2} />;
const ScheduleIcon = ({ color, size }: TabIconProps) => <CalendarDays size={size} color={color} strokeWidth={2.2} />;
const AbsenceIcon = ({ color, size }: TabIconProps) => <CalendarHeart size={size} color={color} strokeWidth={2.2} />;
const ExpensesIcon = ({ color, size }: TabIconProps) => <Receipt size={size} color={color} strokeWidth={2.2} />;
const AnnouncementsIcon = ({ color, size }: TabIconProps) => <Megaphone size={size} color={color} strokeWidth={2.2} />;

export default function TabLayout() {
  const { t } = useI18n();
  const { access, isLoading } = useHrAccess();
  // Keep the My HR tabs up while permissions load, so they do not flicker away and back.
  const self = access.self || isLoading;
  const pendingLeave = usePendingLeave(access.approveLeave);
  const pendingExpenses = usePendingExpenses(access.approveExpenses);

  const leaveWaiting = pendingLeave.data?.length ?? 0;
  const expensesWaiting = pendingExpenses.data?.length ?? 0;
  const unreadAnnouncements = useAnnouncements(access.self).data?.unread ?? 0;
  const hidden = (show: boolean) => (show ? undefined : null);

  return (
    <View style={styles.flex}>
      <Tabs
        tabBar={renderTabBar}
        screenOptions={{
          ...floatingTabBarScreenOptions,
          headerShown: false,
          tabBarShowLabel: false,
        }}
      >
        <Tabs.Screen name="index" options={{ title: t.tabs.home, tabBarIcon: HomeIcon, tabBarButtonTestID: 'tab-home' }} />
        <Tabs.Screen
          name="schedule"
          options={{
            title: t.tabs.schedule,
            tabBarIcon: ScheduleIcon,
            href: hidden(self || access.attendance),
            tabBarButtonTestID: 'tab-schedule',
          }}
        />
        <Tabs.Screen
          name="absence"
          options={{
            title: t.tabs.absence,
            tabBarIcon: AbsenceIcon,
            href: hidden(self || access.leave || access.sickToday || access.approveLeave),
            tabBarBadge: leaveWaiting > 0 ? leaveWaiting : undefined,
            tabBarButtonTestID: 'tab-absence',
          }}
        />
        <Tabs.Screen
          name="expenses"
          options={{
            title: t.tabs.expenses,
            tabBarIcon: ExpensesIcon,
            href: hidden(self || access.approveExpenses),
            tabBarBadge: expensesWaiting > 0 ? expensesWaiting : undefined,
            tabBarButtonTestID: 'tab-expenses',
          }}
        />
        <Tabs.Screen
          name="announcements"
          options={{
            title: t.tabs.announcements,
            tabBarIcon: AnnouncementsIcon,
            href: hidden(self),
            tabBarBadge: unreadAnnouncements > 0 ? unreadAnnouncements : undefined,
            tabBarButtonTestID: 'tab-announcements',
          }}
        />
      </Tabs>
      <AddButton />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
});
