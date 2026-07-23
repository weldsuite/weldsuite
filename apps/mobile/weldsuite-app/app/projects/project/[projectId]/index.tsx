import { Redirect, useLocalSearchParams } from 'expo-router';

export default function ProjectDetailIndex() {
  const { projectId } = useLocalSearchParams();
  return <Redirect href={`/projects/project/${projectId}/tasks` as any} />;
}
