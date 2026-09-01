import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, TextInput, ScrollView, Pressable, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { ConfirmModal } from '@weldsuite/mobile-ui/components/ConfirmModal';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import { Screen, ScreenHeader, SectionLabel } from '@/components/screen';
import { SectionCard, DetailRow } from '@/components/detail';
import { StatusBadge } from '@/components/status-badge';
import { DetailSkeleton, ErrorState } from '@/components/data-states';
import { RecordRow } from '@/components/record-row';
import { useI18n } from '@/lib/i18n';
import { formatRelativeTime } from '@/lib/date';
import appApi from '@/services/app-api';
import type {
  WorkspaceAgent,
  WorkspaceAgentRun,
  WorkspaceAgentToolCatalogItem,
} from '@weldsuite/app-api-client/schemas/workspace-agents';

export default function AgentDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const toast = useToast();
  const { t, format } = useI18n();

  const [agent, setAgent] = useState<(WorkspaceAgent & { availableTools?: WorkspaceAgentToolCatalogItem[] }) | null>(
    null,
  );
  const [grantable, setGrantable] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<WorkspaceAgentToolCatalogItem[]>([]);
  const [runs, setRuns] = useState<WorkspaceAgentRun[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [permissions, setPermissions] = useState<string[]>([]);
  const [runMessage, setRunMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setError(null);
    try {
      const [agentRes, grantsRes, toolsRes, runsRes] = await Promise.all([
        appApi.agents.get(id),
        appApi.agents.listGrantablePermissions(),
        appApi.agents.listTools(),
        appApi.agents.listRuns(id, 20),
      ]);
      const next = agentRes.data;
      setAgent(next);
      setName(next.name);
      setDescription(next.description ?? '');
      setSystemPrompt(next.systemPrompt);
      setPermissions(next.permissions ?? []);
      setGrantable(grantsRes.data ?? []);
      setCatalog(toolsRes.data ?? []);
      setRuns(runsRes.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.somethingWentWrong);
    } finally {
      setLoading(false);
    }
  }, [id, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const unlockedTools = useMemo(() => {
    const set = new Set(permissions);
    return catalog.filter((tool) =>
      tool.requiredPermissions.every(
        (p) => set.has(p) || set.has(`${p.split(':')[0]}:*`) || set.has('*'),
      ),
    );
  }, [catalog, permissions]);

  const togglePermission = (key: string) => {
    setPermissions((prev) => (prev.includes(key) ? prev.filter((p) => p !== key) : [...prev, key]));
  };

  const save = async () => {
    if (!id) return;
    setSaving(true);
    try {
      const res = await appApi.agents.update(id, {
        name: name.trim() || agent?.name,
        description: description.trim() || null,
        systemPrompt,
        permissions,
      });
      setAgent(res.data);
      toast.success(t.agentDetail.saved);
    } finally {
      setSaving(false);
    }
  };

  const activate = async () => {
    if (!id) return;
    const res = await appApi.agents.activate(id);
    setAgent(res.data);
  };

  const pause = async () => {
    if (!id) return;
    const res = await appApi.agents.pause(id);
    setAgent(res.data);
  };

  const runNow = async () => {
    if (!id) return;
    setRunning(true);
    try {
      const res = await appApi.agents.run(id, { message: runMessage.trim() || undefined });
      if (res.data.success) toast.success(t.agentDetail.runSucceeded);
      else toast.error(t.agentDetail.runFailed);
      const runsRes = await appApi.agents.listRuns(id, 20);
      setRuns(runsRes.data ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t.agentDetail.runFailed);
    } finally {
      setRunning(false);
    }
  };

  const remove = async () => {
    if (!id) return;
    await appApi.agents.delete(id);
    router.back();
  };

  if (loading) {
    return (
      <Screen header={<ScreenHeader title={t.agentDetail.title} showBack />}>
        <DetailSkeleton />
      </Screen>
    );
  }

  if (error || !agent) {
    return (
      <Screen header={<ScreenHeader title={t.agentDetail.title} showBack />}>
        <ErrorState message={error ?? t.common.somethingWentWrong} onRetry={() => void load()} />
      </Screen>
    );
  }

  return (
    <Screen header={<ScreenHeader title={agent.name || t.agents.untitled} showBack />}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.statusRow}>
          <StatusBadge status={agent.status} />
        </View>

        <SectionCard title={t.agentDetail.name}>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder={t.agentDetail.namePlaceholder}
            placeholderTextColor={colors.mutedForeground}
            style={[styles.input, { color: colors.text }]}
          />
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder={t.agentDetail.descriptionPlaceholder}
            placeholderTextColor={colors.mutedForeground}
            style={[styles.input, { color: colors.text }]}
          />
        </SectionCard>

        <SectionCard title={t.agentDetail.instructions}>
          <TextInput
            value={systemPrompt}
            onChangeText={setSystemPrompt}
            placeholder={t.agentDetail.instructionsPlaceholder}
            placeholderTextColor={colors.mutedForeground}
            multiline
            style={[styles.textarea, { color: colors.text }]}
          />
        </SectionCard>

        <SectionCard title={t.agentDetail.permissions}>
          <Text style={[styles.hint, { color: colors.mutedForeground }]}>{t.agentDetail.permissionsHint}</Text>
          {grantable.slice(0, 40).map((key) => {
            const on = permissions.includes(key);
            return (
              <Pressable
                key={key}
                onPress={() => togglePermission(key)}
                style={styles.permRow}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
              >
                <View
                  style={[
                    styles.checkbox,
                    { borderColor: colors.border, backgroundColor: on ? colors.text : 'transparent' },
                  ]}
                />
                <Text style={[styles.permLabel, { color: colors.text }]}>{key}</Text>
              </Pressable>
            );
          })}
        </SectionCard>

        <SectionCard title={t.agentDetail.tools}>
          {unlockedTools.length === 0 ? (
            <Text style={[styles.hint, { color: colors.mutedForeground }]}>{t.agentDetail.noTools}</Text>
          ) : (
            unlockedTools.map((tool) => (
              <DetailRow key={tool.id} label={tool.name} value={tool.description} />
            ))
          )}
        </SectionCard>

        <SectionCard title={t.agentDetail.eventSubscriptions}>
          <Text style={{ color: colors.text }}>
            {agent.eventSubscriptions?.length
              ? agent.eventSubscriptions.join(', ')
              : t.agentDetail.none}
          </Text>
        </SectionCard>

        <SectionCard title={t.agentDetail.runNow}>
          <TextInput
            value={runMessage}
            onChangeText={setRunMessage}
            placeholder={t.agentDetail.runPromptPlaceholder}
            placeholderTextColor={colors.mutedForeground}
            style={[styles.input, { color: colors.text }]}
          />
          <Button title={t.common.runNow} onPress={() => void runNow()} loading={running} />
        </SectionCard>

        <SectionLabel>{t.agentDetail.runs}</SectionLabel>
        {runs.length === 0 ? (
          <Text style={[styles.hint, { color: colors.mutedForeground, paddingHorizontal: 16 }]}>
            {t.agentDetail.noRuns}
          </Text>
        ) : (
          runs.map((run) => (
            <RecordRow
              key={run.id}
              title={run.triggerType ?? t.activity.triggerManual}
              subtitle={run.result?.summary ?? run.error ?? t.common.dash}
              meta={formatRelativeTime(run.createdAt, t.relativeTime, format)}
              badge={<StatusBadge status={run.status} />}
            />
          ))
        )}

        <View style={styles.actions}>
          <Button title={t.agentDetail.save} onPress={() => void save()} loading={saving} />
          {agent.status === 'active' ? (
            <Button title={t.common.pause} variant="outline" onPress={() => void pause()} />
          ) : (
            <Button title={t.common.activate} variant="outline" onPress={() => void activate()} />
          )}
          <Button
            title={t.agentDetail.delete}
            variant="destructive"
            onPress={() => setConfirmDelete(true)}
          />
        </View>
      </ScrollView>

      <ConfirmModal
        visible={confirmDelete}
        title={t.agentDetail.delete}
        message={t.agentDetail.deleteConfirm}
        confirmText={t.common.delete}
        cancelText={t.common.cancel}
        variant="destructive"
        onConfirm={() => {
          setConfirmDelete(false);
          void remove();
        }}
        onCancel={() => setConfirmDelete(false)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 40 },
  statusRow: { paddingHorizontal: 16, paddingTop: 8 },
  input: { fontSize: 16, paddingVertical: 8 },
  textarea: { fontSize: 15, minHeight: 120, textAlignVertical: 'top', paddingVertical: 8 },
  hint: { fontSize: 13, marginBottom: 8, lineHeight: 18 },
  permRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
  checkbox: { width: 18, height: 18, borderRadius: 4, borderWidth: 1.5 },
  permLabel: { fontSize: 14, flex: 1 },
  actions: { padding: 16, gap: 10 },
});
