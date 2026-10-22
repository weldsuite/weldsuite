import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { router, useFocusEffect, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useObserve } from 'expo-observe';
import { Activity, CheckSquare, FileText, Mail, Phone, Plus, Video, type LucideIcon } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { OptionSheet } from '@/components/option-sheet';
import { TaskItem } from '@/components/task-item';
import { TaskSheet } from '@/components/task-sheet';
import { api, type CrmActivity } from '@/services/api';
import { tasksApi, type CrmTask } from '@/services/tasks';
import { hideAppSplash } from '@/utils/splash';
import { useI18n } from '@/lib/i18n';
import { dueToday } from '@/lib/task-groups';

const ACTIVITY_ICONS: Record<string, LucideIcon> = {
  call: Phone,
  email: Mail,
  meeting: Video,
  note: FileText,
  task: CheckSquare,
};

type CreateAction = 'person' | 'company' | 'task' | 'note' | 'deal' | 'activity';

const CREATE_ROUTES: Record<Exclude<CreateAction, 'task'>, Href> = {
  person: '/person/new',
  company: '/company/new',
  note: { pathname: '/note/[id]', params: { id: 'new' } },
  deal: '/deal/new',
  activity: '/activity/new',
};

function greetingKey(now: Date): 'morning' | 'afternoon' | 'evening' {
  const hour = now.getHours();
  if (hour < 12) return 'morning';
  return hour < 18 ? 'afternoon' : 'evening';
}

export default function HomeScreen() {
  const { markInteractive } = useObserve();
  const { colors } = useTheme();
  const { t, intlLocale } = useI18n();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const { user } = useClerkAuth();

  const [tasks, setTasks] = useState<CrmTask[]>([]);
  const [activities, setActivities] = useState<CrmActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [sheet, setSheet] = useState<{ visible: boolean; task: CrmTask | null; mode: 'view' | 'create' }>({
    visible: false,
    task: null,
    mode: 'view',
  });
  const loadedOnce = useRef(false);
  const userId = user?.id;

  const load = useCallback(
    async (silent = false) => {
      const [tasksRes, activitiesRes] = await Promise.all([
        userId ? tasksApi.list({ assigneeId: userId, limit: 100 }) : Promise.resolve(null),
        api.getActivities({ limit: 6 }),
      ]);
      if (tasksRes?.success && tasksRes.data) setTasks(dueToday(tasksRes.data.items));
      if (activitiesRes.success && activitiesRes.data) setActivities(activitiesRes.data.items);
      if (!silent && (tasksRes?.success === false || !activitiesRes.success)) toast.error(t.home.loadFailed);
      loadedOnce.current = true;
      setLoading(false);
      setRefreshing(false);
    },
    [userId, t, toast],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Coming back from another screen: refresh quietly.
  useFocusEffect(
    useCallback(() => {
      if (loadedOnce.current) void load(true);
    }, [load]),
  );

  useEffect(() => {
    if (!loading) {
      hideAppSplash();
      markInteractive();
    }
  }, [loading, markInteractive]);

  const create = (action: CreateAction | null) => {
    setCreateOpen(false);
    if (!action) return;
    if (action === 'task') setSheet({ visible: true, task: null, mode: 'create' });
    else router.push(CREATE_ROUTES[action]);
  };

  const toggleTask = async (task: CrmTask) => {
    const res = await tasksApi.update(task.id, { status: task.completed ? 'todo' : 'done' });
    if (res.success && res.data) {
      const saved = res.data;
      setTasks((prev) => prev.map((item) => (item.id === saved.id ? saved : item)));
    } else {
      toast.error(t.tasks.updateFailed);
    }
  };

  const openActivity = (activity: CrmActivity) => {
    if (activity.type === 'note') {
      router.push({ pathname: '/note/[id]', params: { id: activity.id } });
      return;
    }
    if (!activity.record) return;
    router.push({
      pathname: activity.record.kind === 'company' ? '/company/[id]' : '/person/[id]',
      params: { id: activity.record.id, name: activity.record.name ?? '', tab: 'activity' },
    });
  };

  const now = new Date();
  const firstName = user?.fullName?.split(' ')[0];
  const greeting = t.home.greeting[greetingKey(now)];
  const closeSheet = () => setSheet((prev) => ({ ...prev, visible: false }));
  const activityTime = (iso: string) =>
    new Date(iso).toLocaleString(intlLocale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  let todayContent: React.ReactNode;
  if (loading) {
    todayContent = <ActivityIndicator style={styles.spinner} color={colors.text} />;
  } else if (tasks.length === 0) {
    todayContent = <Text style={[styles.empty, { color: colors.muted }]}>{t.home.nothingDue}</Text>;
  } else {
    todayContent = tasks.map((task) => (
      <TaskItem
        key={task.id}
        task={task}
        onPress={(item) => setSheet({ visible: true, task: item, mode: 'view' })}
        onToggle={(item) => void toggleTask(item)}
      />
    ));
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load();
            }}
          />
        }
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 16 }]}
      >
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={[styles.greeting, { color: colors.text }]} accessibilityRole="header">
              {firstName ? `${greeting}, ${firstName}` : greeting}
            </Text>
            <Text style={[styles.date, { color: colors.muted }]}>
              {now.toLocaleDateString(intlLocale, { weekday: 'long', day: 'numeric', month: 'long' })}
            </Text>
          </View>
          <TouchableOpacity
            style={[styles.createButton, { backgroundColor: colors.text }]}
            onPress={() => setCreateOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={t.home.create}
          >
            <Plus size={22} color={colors.background} strokeWidth={2.2} />
          </TouchableOpacity>
        </View>

        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>{t.home.today}</Text>
          <TouchableOpacity onPress={() => router.navigate('/tasks')} accessibilityRole="link">
            <Text style={[styles.sectionLink, { color: colors.muted }]}>{t.home.allTasks}</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.section}>{todayContent}</View>

        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>{t.home.recentActivities}</Text>
        </View>
        <View style={styles.section}>
          {!loading && activities.length === 0 && (
            <Text style={[styles.empty, { color: colors.muted }]}>{t.home.noActivity}</Text>
          )}
          {activities.map((activity) => {
            const Icon = ACTIVITY_ICONS[activity.type] ?? Activity;
            return (
              <TouchableOpacity
                key={activity.id}
                style={[styles.activity, { borderBottomColor: colors.divider }]}
                onPress={() => openActivity(activity)}
                disabled={activity.type !== 'note' && !activity.record}
                accessibilityRole="button"
                accessibilityLabel={activity.subject}
              >
                <Icon size={16} color={colors.muted} />
                <View style={styles.activityText}>
                  <Text style={[styles.activityTitle, { color: colors.text }]} numberOfLines={1}>
                    {activity.subject}
                  </Text>
                  <Text style={[styles.activityMeta, { color: colors.muted }]} numberOfLines={1}>
                    {[activity.record?.name, activityTime(activity.createdAt)].filter(Boolean).join(' · ')}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      </ScrollView>

      <OptionSheet<CreateAction>
        visible={createOpen}
        title={t.home.create}
        options={[
          { value: 'person', label: t.home.actions.addPerson },
          { value: 'company', label: t.home.actions.addCompany },
          { value: 'task', label: t.home.actions.newTask },
          { value: 'note', label: t.home.actions.newNote },
          { value: 'deal', label: t.home.actions.createDeal },
          { value: 'activity', label: t.home.actions.logActivity },
        ]}
        onSelect={create}
        onClose={() => setCreateOpen(false)}
      />
      <TaskSheet
        visible={sheet.visible}
        initialMode={sheet.mode}
        task={sheet.task}
        onClose={closeSheet}
        onCreated={() => {
          closeSheet();
          void load(true);
        }}
        onUpdated={(task) => {
          setTasks((prev) => prev.map((item) => (item.id === task.id ? task : item)));
          setSheet((prev) => (prev.task?.id === task.id ? { ...prev, task } : prev));
        }}
        onDeleted={(id) => {
          setTasks((prev) => prev.filter((item) => item.id !== id));
          closeSheet();
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: 20, paddingBottom: 32 },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 28 },
  headerText: { flex: 1 },
  greeting: { fontSize: 28, fontWeight: '700' },
  date: { fontSize: 15, marginTop: 4 },
  createButton: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  sectionTitle: { fontSize: 18, fontWeight: '600' },
  sectionLink: { fontSize: 14 },
  section: { marginBottom: 28 },
  spinner: { paddingVertical: 24 },
  empty: { fontSize: 14, paddingVertical: 8 },
  activity: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  activityText: { flex: 1 },
  activityTitle: { fontSize: 15 },
  activityMeta: { fontSize: 13, marginTop: 2 },
});
