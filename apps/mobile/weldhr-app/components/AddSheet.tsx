/**
 * What an employee starts from the phone, behind the round "+" above the tab
 * bar: ask for a shift, request time off, report sick (or better), and a new
 * expense. Time off and expenses follow the workspace's switches.
 */

import { StyleSheet } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { CalendarClock, CalendarPlus, Receipt, Thermometer } from 'lucide-react-native';
import { Sheet } from '@weldsuite/mobile-ui/components/Sheet';

import type { LinkedSelf } from '@/components/MyHrGate';
import { Card, IconTile, Row } from '@/components/Row';
import { useAbsences } from '@/hooks/use-weldhr-queries';
import { useI18n } from '@/lib/i18n';

export function AddSheet({ self, onClose }: Readonly<{ self: LinkedSelf; onClose: () => void }>) {
  const { t } = useI18n();
  const router = useRouter();
  const absences = useAbsences();
  const sick = absences.data?.current != null;

  const go = (href: Href) => {
    onClose();
    router.push(href);
  };

  return (
    <Sheet visible onClose={onClose} title={t.home.add} heightRatio={0.5}>
      <Card style={styles.card}>
        <Row
          leading={<IconTile icon={CalendarClock} />}
          title={t.home.requestShift}
          onPress={() => go('/shift/new')}
          chevron
          testID="add-shift"
        />
        {self.features.leaveRequests ? (
          <Row
            leading={<IconTile icon={CalendarPlus} />}
            title={t.home.requestTimeOff}
            onPress={() => go('/leave/new')}
            chevron
            testID="add-leave"
          />
        ) : null}
        <Row
          leading={<IconTile icon={Thermometer} />}
          title={sick ? t.home.imBetter : t.home.reportSick}
          onPress={() => go('/sick')}
          chevron
          testID="add-sick"
        />
        {self.features.declarations ? (
          <Row
            leading={<IconTile icon={Receipt} />}
            title={t.home.newExpense}
            onPress={() => go('/expense/new')}
            chevron
            testID="add-expense"
          />
        ) : null}
      </Card>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: 0, marginTop: 4 },
});
