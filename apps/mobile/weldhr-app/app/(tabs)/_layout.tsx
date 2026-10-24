/**
 * One app for everyone: the My HR tabs for every employee, plus Team for
 * people who can act on other people's records (approve leave or expenses,
 * see who is out, look up colleagues). Pay shows once the workspace runs
 * payroll in WeldHR.
 */

import { Tabs } from 'expo-router';
import type { ColorValue } from 'react-native';
import { CalendarDays, House, Receipt, UserRound, UsersRound, Wallet } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { BRAND } from '@/constants/brand';
import { useHrAccess, usePayslips, usePendingExpenses, usePendingLeave } from '@/hooks/use-weldhr-queries';
import { useI18n } from '@/lib/i18n';

type TabIconProps = { color: ColorValue; size: number };

const HomeTabIcon = ({ color, size }: TabIconProps) => <House size={size} color={color} />;
const TimeOffTabIcon = ({ color, size }: TabIconProps) => <CalendarDays size={size} color={color} />;
const ExpensesTabIcon = ({ color, size }: TabIconProps) => <Receipt size={size} color={color} />;
const PayTabIcon = ({ color, size }: TabIconProps) => <Wallet size={size} color={color} />;
const TeamTabIcon = ({ color, size }: TabIconProps) => <UsersRound size={size} color={color} />;
const MeTabIcon = ({ color, size }: TabIconProps) => <UserRound size={size} color={color} />;

export default function TabLayout() {
  const { colors } = useTheme();
  const { t } = useI18n();
  const { access, isLoading } = useHrAccess();
  // Keep the My HR tabs up while permissions load, so they do not flicker away and back.
  const self = access.self || isLoading;
  const payslips = usePayslips(access.self);
  const pendingLeave = usePendingLeave(access.approveLeave);
  const pendingExpenses = usePendingExpenses(access.approveExpenses);

  // `null` means hr-api answered 404: payroll is off for this workspace.
  const showPay = access.self && payslips.data != null;
  const waiting = (pendingLeave.data?.length ?? 0) + (pendingExpenses.data?.length ?? 0);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: BRAND,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: { backgroundColor: colors.background, borderTopColor: colors.divider },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '500' },
      }}
    >
      <Tabs.Screen name="index" options={{ title: t.tabs.home, tabBarIcon: HomeTabIcon, tabBarButtonTestID: 'tab-home' }} />
      <Tabs.Screen
        name="time-off"
        options={{ title: t.tabs.timeOff, tabBarIcon: TimeOffTabIcon, href: self ? undefined : null, tabBarButtonTestID: 'tab-time-off' }}
      />
      <Tabs.Screen
        name="expenses"
        options={{ title: t.tabs.expenses, tabBarIcon: ExpensesTabIcon, href: self ? undefined : null, tabBarButtonTestID: 'tab-expenses' }}
      />
      <Tabs.Screen name="pay" options={{ title: t.tabs.pay, tabBarIcon: PayTabIcon, href: showPay ? undefined : null, tabBarButtonTestID: 'tab-pay' }} />
      <Tabs.Screen
        name="team"
        options={{
          title: t.tabs.team,
          tabBarIcon: TeamTabIcon,
          href: access.team ? undefined : null,
          tabBarButtonTestID: 'tab-team',
          tabBarBadge: waiting > 0 ? waiting : undefined,
          tabBarBadgeStyle: { backgroundColor: BRAND, color: '#fff', fontSize: 11 },
        }}
      />
      <Tabs.Screen name="me" options={{ title: t.tabs.me, tabBarIcon: MeTabIcon, tabBarButtonTestID: 'tab-me' }} />
    </Tabs>
  );
}
