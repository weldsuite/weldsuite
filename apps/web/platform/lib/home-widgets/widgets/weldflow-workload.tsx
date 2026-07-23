import { z } from 'zod';
import { Users } from 'lucide-react';
import { WorkloadCard } from '@/components/home/app-cards';
import { NoSettingsForm } from '../common';
import type { HomeWidgetDefinition } from '../types';

const weldflowWorkloadSchema = z.object({});
export type WeldflowWorkloadSettings = z.infer<typeof weldflowWorkloadSchema>;

function Render() {
  return <WorkloadCard />;
}

export const weldflowWorkloadWidget: HomeWidgetDefinition<WeldflowWorkloadSettings> = {
  id: 'weldflow-workload',
  module: 'weldflow',
  title: 'Workload',
  description: 'Team availability + utilization',
  icon: Users,
  schema: weldflowWorkloadSchema,
  defaultSettings: {},
  HomeRender: Render,
  SettingsForm: NoSettingsForm,
};
