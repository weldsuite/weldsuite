import { useMyHrSelf } from './components/my-hr-context';
import { useMyHrBreadcrumbs } from './components/my-hr-page';
import { MyHrRecord } from './components/my-hr-record';

/** My HR → Overview: your own employee record, with the time clock and what needs your attention. */
export default function WeldHrMePage() {
  useMyHrBreadcrumbs();
  const { employee, features } = useMyHrSelf();
  return <MyHrRecord employee={employee} canClockIn={features.selfClockIn} />;
}
