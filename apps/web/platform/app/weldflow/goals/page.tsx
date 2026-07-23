
import { GoalsCanvasView } from '@/components/weldflow/goals/goals-canvas-view';
import { useTranslations } from '@weldsuite/i18n/client';

export default function GoalsPage() {
  const st = useTranslations();

  const defaultGoalsData = {
    mission: {
      id: 'mission-1',
      title: st('sweep.weldflow.goalsPage.missionTitle'),
      description: st('sweep.weldflow.goalsPage.missionDescription'),
      x: 600,
      y: 50,
      width: 320,
      height: 160,
      subGoals: [],
    },
    goals: [],
  };

  return (
    <GoalsCanvasView
      projectId=""
      initialGoalsData={defaultGoalsData}
      initialTasks={[]}
    />
  );
}