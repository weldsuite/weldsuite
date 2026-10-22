/**
 * The tabs under a company or person, like the platform's record panel:
 * Activity, Notes, Tasks, Deals, People / Companies, Emails, Calls, Meetings,
 * Files, Audit log and Chat. Each panel loads its own data when shown and
 * again when `refreshKey` changes (the screen bumps it on focus).
 */

import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { router } from 'expo-router';
import {
  Calendar,
  CheckSquare,
  FileText,
  Mail,
  MessageSquare,
  Paperclip,
  Phone,
  PhoneIncoming,
  PhoneOutgoing,
  Plus,
  Send,
  Star,
  Trash2,
  Users,
  Video,
  type LucideIcon,
} from 'lucide-react-native';
import type { ApiResponse } from '@weldsuite/mobile-ui/types';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { CompanyPicker, PersonPicker } from '@/components/company-picker';
import { useMembers } from '@/components/member-picker';
import { RecordLinkRow } from '@/components/record';
import { TaskItem } from '@/components/task-item';
import { TaskSheet, type TaskSheetMode } from '@/components/task-sheet';
import { api, type CrmActivity, type DealRecord } from '@/services/api';
import { notesApi, type NoteRecord, type RecordRef } from '@/services/notes';
import { recordTabsApi, type ChatMessage } from '@/services/record-tabs';
import { tasksApi, type CrmTask } from '@/services/tasks';
import { interpolate, plural, useI18n } from '@/lib/i18n';
import { formatMoney } from '@/lib/money';
import { htmlToText } from '@/lib/note-text';

const ACCENT = '#7C3AED';

/** Load `fetch` while mounted and whenever a dependency or `refreshKey` changes. */
function useLoad<T>(fetch: () => Promise<ApiResponse<T>>, deps: readonly unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const requestId = useRef(0);

  const reload = useCallback(async () => {
    const current = ++requestId.current;
    const res = await fetch();
    if (current !== requestId.current) return;
    if (res.success && res.data !== undefined) {
      setData(res.data);
      setError(false);
    } else {
      setError(true);
    }
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, setData, loading, error, reload };
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function PanelState({ loading, error, empty, emptyText }: Readonly<{ loading: boolean; error: boolean; empty: boolean; emptyText: string }>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  if (loading) return <ActivityIndicator style={styles.spinner} color={colors.text} />;
  if (error) return <Text style={[styles.empty, { color: colors.muted }]}>{t.records.loadFailed}</Text>;
  if (empty) return <Text style={[styles.empty, { color: colors.muted }]}>{emptyText}</Text>;
  return null;
}

function AddButton({ label, onPress }: Readonly<{ label: string; onPress: () => void }>) {
  const { colors } = useTheme();
  return (
    <TouchableOpacity
      style={[styles.addButton, { borderColor: colors.divider }]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Plus size={16} color={colors.text} />
      <Text style={[styles.addButtonText, { color: colors.text }]}>{label}</Text>
    </TouchableOpacity>
  );
}

interface ItemRowProps {
  icon: LucideIcon;
  iconColor?: string;
  title: string;
  subtitle?: string;
  meta?: string;
  body?: string;
  onPress?: () => void;
  onLongPress?: () => void;
  right?: ReactNode;
}

function ItemRow({ icon: Icon, iconColor, title, subtitle, meta, body, onPress, onLongPress, right }: Readonly<ItemRowProps>) {
  const { colors } = useTheme();
  return (
    <TouchableOpacity
      style={[styles.item, { borderBottomColor: colors.divider }]}
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={!onPress && !onLongPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={title}
    >
      <View style={[styles.itemIcon, { backgroundColor: colors.secondary }]}>
        <Icon size={16} color={iconColor ?? colors.text} />
      </View>
      <View style={styles.itemText}>
        <Text style={[styles.itemTitle, { color: colors.text }]} numberOfLines={2}>
          {title}
        </Text>
        {!!subtitle && (
          <Text style={[styles.itemSub, { color: colors.muted }]} numberOfLines={1}>
            {subtitle}
          </Text>
        )}
        {!!body && (
          <Text style={[styles.itemBody, { color: colors.text }]} numberOfLines={3}>
            {body}
          </Text>
        )}
      </View>
      {!!meta && <Text style={[styles.itemMeta, { color: colors.muted }]}>{meta}</Text>}
      {right}
    </TouchableOpacity>
  );
}

function useDateFormat() {
  const { intlLocale } = useI18n();
  return {
    date: (iso?: string) => (iso ? new Date(iso).toLocaleDateString(intlLocale, { day: 'numeric', month: 'short', year: 'numeric' }) : ''),
    dateTime: (iso?: string) =>
      iso ? new Date(iso).toLocaleString(intlLocale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '',
  };
}

interface PanelProps {
  record: RecordRef;
  refreshKey: number;
}

const recordParams = (record: RecordRef) => ({
  recordKind: record.kind,
  recordId: record.id,
  recordName: record.name ?? '',
});

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

const ACTIVITY_ICONS: Record<string, LucideIcon> = {
  call: Phone,
  email: Mail,
  meeting: Video,
  note: FileText,
  task: CheckSquare,
};

export function ActivityPanel({ record, refreshKey }: Readonly<PanelProps>) {
  const { t } = useI18n();
  const { dateTime } = useDateFormat();
  const { byId } = useMembers();
  const { data, loading, error } = useLoad(
    () => api.getActivities({ record, limit: 50 }),
    [record.kind, record.id, refreshKey],
  );
  const items: CrmActivity[] = data?.items ?? [];
  const typeLabel = (type: string) => (t.activity.types as Record<string, string>)[type] ?? type;

  return (
    <View>
      <AddButton
        label={t.activity.title}
        onPress={() => router.push({ pathname: '/activity/new', params: recordParams(record) })}
      />
      <PanelState loading={loading} error={error} empty={items.length === 0} emptyText={t.records.noActivity} />
      {items.map((item) => (
        <ItemRow
          key={item.id}
          icon={ACTIVITY_ICONS[item.type] ?? MessageSquare}
          title={item.type === 'note' ? item.subject : `${typeLabel(item.type)} · ${item.subject}`}
          subtitle={[dateTime(item.createdAt), item.assignedToId ? byId.get(item.assignedToId)?.name : undefined]
            .filter(Boolean)
            .join(' · ')}
          body={item.description ? htmlToText(item.description) : undefined}
          onPress={item.type === 'note' ? () => router.push({ pathname: '/note/[id]', params: { id: item.id } }) : undefined}
        />
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export function NotesPanel({ record, refreshKey }: Readonly<PanelProps>) {
  const { t } = useI18n();
  const { dateTime } = useDateFormat();
  const { data, loading, error } = useLoad(() => notesApi.list({ record, limit: 50 }), [record.kind, record.id, refreshKey]);
  const notes: NoteRecord[] = data?.items ?? [];

  return (
    <View>
      <AddButton
        label={t.notes.add}
        onPress={() => router.push({ pathname: '/note/[id]', params: { id: 'new', ...recordParams(record) } })}
      />
      <PanelState loading={loading} error={error} empty={notes.length === 0} emptyText={t.notes.emptyRecord} />
      {notes.map((note) => (
        <ItemRow
          key={note.id}
          icon={FileText}
          title={note.subject}
          subtitle={dateTime(note.updatedAt)}
          body={htmlToText(note.html).split('\n').slice(1).join(' ').trim() || undefined}
          right={note.isFavorite ? <Star size={14} color="#F59E0B" fill="#F59E0B" /> : undefined}
          onPress={() => router.push({ pathname: '/note/[id]', params: { id: note.id } })}
        />
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export function TasksPanel({ record, refreshKey }: Readonly<PanelProps>) {
  const { t } = useI18n();
  const toast = useToast();
  const { data, setData, loading, error } = useLoad(
    () => tasksApi.list({ record, limit: 100 }),
    [record.kind, record.id, refreshKey],
  );
  const [sheet, setSheet] = useState<{ visible: boolean; mode: TaskSheetMode; task: CrmTask | null }>({
    visible: false,
    mode: 'view',
    task: null,
  });
  const tasks = data?.items ?? [];
  const replace = (task: CrmTask) =>
    setData((prev) => (prev ? { ...prev, items: prev.items.map((item) => (item.id === task.id ? task : item)) } : prev));

  const toggle = async (task: CrmTask) => {
    const res = await tasksApi.update(task.id, { status: task.completed ? 'todo' : 'done' });
    if (res.success && res.data) replace(res.data);
    else toast.error(t.tasks.updateFailed);
  };
  const close = () => setSheet((prev) => ({ ...prev, visible: false }));

  return (
    <View>
      <AddButton label={t.tasks.newTitle} onPress={() => setSheet({ visible: true, mode: 'create', task: null })} />
      <PanelState loading={loading} error={error} empty={tasks.length === 0} emptyText={t.records.noTasks} />
      {tasks.map((task) => (
        <TaskItem
          key={task.id}
          task={task}
          hideRecord
          onPress={(item) => setSheet({ visible: true, mode: 'view', task: item })}
          onToggle={(item) => void toggle(item)}
        />
      ))}
      <TaskSheet
        visible={sheet.visible}
        initialMode={sheet.mode}
        task={sheet.task}
        defaultRecord={record}
        onClose={close}
        onCreated={(task) => {
          setData((prev) => (prev ? { ...prev, items: [task, ...prev.items] } : prev));
          close();
        }}
        onUpdated={(task) => {
          replace(task);
          setSheet((prev) => (prev.task?.id === task.id ? { ...prev, task } : prev));
        }}
        onDeleted={(id) => {
          setData((prev) => (prev ? { ...prev, items: prev.items.filter((item) => item.id !== id) } : prev));
          close();
        }}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Deals
// ---------------------------------------------------------------------------

export function DealsPanel({ record, refreshKey, currency }: Readonly<PanelProps & { currency: string }>) {
  const { t, intlLocale } = useI18n();
  const { date } = useDateFormat();
  const { data, loading, error } = useLoad<DealRecord[]>(
    () => (record.kind === 'company' ? api.getCompanyDeals(record.id) : api.getPersonDeals(record.id)),
    [record.kind, record.id, refreshKey],
  );
  const deals = data ?? [];
  const params =
    record.kind === 'company'
      ? { companyId: record.id, companyName: record.name ?? '' }
      : { personId: record.id, personName: record.name ?? '' };

  return (
    <View>
      <AddButton label={t.deals.newDeal} onPress={() => router.push({ pathname: '/deal/new', params })} />
      <PanelState loading={loading} error={error} empty={deals.length === 0} emptyText={t.company.noDeals} />
      {deals.map((deal) => (
        <RecordLinkRow
          key={deal.id}
          title={deal.name}
          subtitle={[t.deals.statuses[deal.status as keyof typeof t.deals.statuses] ?? deal.status, date(deal.expectedCloseDate)]
            .filter(Boolean)
            .join(' · ')}
          trailing={deal.value ? formatMoney(deal.value, deal.currency ?? currency, intlLocale, { compact: true }) : undefined}
          onPress={() => router.push({ pathname: '/deal/[id]', params: { id: deal.id, name: deal.name } })}
        />
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// People at a company / companies of a person
// ---------------------------------------------------------------------------

interface LinkRow {
  linkId: string;
  targetId: string;
  name: string;
  subtitle?: string;
  isPrimary: boolean;
}

export function LinksPanel({ record, refreshKey }: Readonly<PanelProps>) {
  const { t } = useI18n();
  const toast = useToast();
  const [pickerVisible, setPickerVisible] = useState(false);
  const { data, loading, error, reload } = useLoad<LinkRow[]>(async () => {
    if (record.kind === 'company') {
      const res = await api.getCompanyPeople(record.id);
      return res.success && res.data
        ? {
            success: true,
            data: res.data.map((p) => ({
              linkId: p.linkId,
              targetId: p.personId,
              name: p.name,
              subtitle: p.role || p.email,
              isPrimary: p.isPrimary,
            })),
          }
        : { success: false, error: res.error };
    }
    const res = await api.getPersonCompanies(record.id);
    return res.success && res.data
      ? {
          success: true,
          data: res.data.map((c) => ({
            linkId: c.linkId,
            targetId: c.companyId,
            name: c.name,
            subtitle: c.role || c.industry,
            isPrimary: c.isPrimary,
          })),
        }
      : { success: false, error: res.error };
  }, [record.kind, record.id, refreshKey]);
  const links = data ?? [];
  const targetKind = record.kind === 'company' ? 'person' : 'company';

  const link = async (targetId: string) => {
    setPickerVisible(false);
    const res = await api.linkPersonToCompany(
      record.kind === 'company'
        ? { companyId: record.id, personId: targetId, isPrimary: false }
        : { personId: record.id, companyId: targetId, isPrimary: links.length === 0 },
    );
    if (res.success) {
      toast.success(t.records.linkedToast);
      void reload();
    } else {
      toast.error(typeof res.error === 'string' ? res.error : t.records.linkFailed);
    }
  };

  const actions = (row: LinkRow) => {
    const buttons: { text: string; style?: 'cancel' | 'destructive'; onPress?: () => void }[] = [
      { text: t.common.cancel, style: 'cancel' },
    ];
    if (!row.isPrimary && record.kind === 'person') {
      buttons.push({
        text: t.records.makePrimary,
        onPress: () => {
          void api.setPrimaryCompanyLink(row.linkId).then((res) => {
            if (res.success) void reload();
            else toast.error(t.records.linkFailed);
          });
        },
      });
    }
    buttons.push({
      text: t.records.unlink,
      style: 'destructive',
      onPress: () => {
        void api.unlinkPersonFromCompany(row.linkId).then((res) => {
          if (res.success) {
            toast.success(t.records.unlinkedToast);
            void reload();
          } else {
            toast.error(t.records.linkFailed);
          }
        });
      },
    });
    Alert.alert(row.name, undefined, buttons);
  };

  return (
    <View>
      <AddButton
        label={record.kind === 'company' ? t.records.linkPerson : t.records.linkCompany}
        onPress={() => setPickerVisible(true)}
      />
      <PanelState
        loading={loading}
        error={error}
        empty={links.length === 0}
        emptyText={record.kind === 'company' ? t.company.noPeople : t.person.noCompanies}
      />
      {links.map((row) => (
        <RecordLinkRow
          key={row.linkId}
          title={row.name}
          subtitle={row.subtitle}
          badge={row.isPrimary ? t.person.primary : undefined}
          onLongPress={() => actions(row)}
          accessibilityHint={t.records.longPressHint}
          onPress={() =>
            router.push({
              pathname: targetKind === 'company' ? '/company/[id]' : '/person/[id]',
              params: { id: row.targetId, name: row.name },
            })
          }
        />
      ))}
      {targetKind === 'person' ? (
        <PersonPicker
          visible={pickerVisible}
          excludeIds={links.map((l) => l.targetId)}
          onClose={() => setPickerVisible(false)}
          onSelect={(person) => void link(person.id)}
        />
      ) : (
        <CompanyPicker
          visible={pickerVisible}
          excludeIds={links.map((l) => l.targetId)}
          onClose={() => setPickerVisible(false)}
          onSelect={(company) => void link(company.id)}
        />
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Emails, calls, meetings
// ---------------------------------------------------------------------------

export function EmailsPanel({ email, refreshKey }: Readonly<{ email?: string; refreshKey: number }>) {
  const { t } = useI18n();
  const { colors } = useTheme();
  const { dateTime } = useDateFormat();
  const { data, loading, error } = useLoad(() => recordTabsApi.emails(email), [email, refreshKey]);
  const [openId, setOpenId] = useState<string | null>(null);
  const emails = data ?? [];

  if (!email) return <Text style={[styles.empty, { color: colors.muted }]}>{t.records.noEmailAddress}</Text>;
  return (
    <View>
      <AddButton label={t.records.composeEmail} onPress={() => void Linking.openURL(`mailto:${email}`)} />
      <PanelState loading={loading} error={error} empty={emails.length === 0} emptyText={t.records.noEmails} />
      {emails.map((mail) => (
        <ItemRow
          key={mail.id}
          icon={mail.hasAttachments ? Paperclip : Mail}
          title={mail.subject || t.records.noSubject}
          subtitle={[mail.fromName || mail.fromEmail, dateTime(mail.date)].filter(Boolean).join(' · ')}
          body={openId === mail.id ? mail.preview : undefined}
          onPress={() => setOpenId(openId === mail.id ? null : mail.id)}
        />
      ))}
    </View>
  );
}

function formatDuration(seconds?: number): string | undefined {
  if (!seconds) return undefined;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

export function CallsPanel({ record, refreshKey, phone }: Readonly<PanelProps & { phone?: string }>) {
  const { t } = useI18n();
  const { dateTime } = useDateFormat();
  const { data, loading, error } = useLoad(() => recordTabsApi.calls(record), [record.kind, record.id, refreshKey]);
  const calls = data ?? [];
  return (
    <View>
      {!!phone && <AddButton label={`${t.common.call} ${phone}`} onPress={() => void Linking.openURL(`tel:${phone}`)} />}
      <PanelState loading={loading} error={error} empty={calls.length === 0} emptyText={t.records.noCalls} />
      {calls.map((call) => (
        <ItemRow
          key={call.id}
          icon={call.direction === 'inbound' ? PhoneIncoming : PhoneOutgoing}
          title={call.number}
          subtitle={[call.direction === 'inbound' ? t.records.inbound : t.records.outbound, dateTime(call.startedAt)].join(' · ')}
          meta={formatDuration(call.duration) ?? call.status}
        />
      ))}
    </View>
  );
}

export function MeetingsPanel({ record, refreshKey }: Readonly<PanelProps>) {
  const { t } = useI18n();
  const { dateTime } = useDateFormat();
  const { data, loading, error } = useLoad(() => recordTabsApi.meetings(record), [record.kind, record.id, refreshKey]);
  const meetings = data ?? [];
  return (
    <View>
      <PanelState loading={loading} error={error} empty={meetings.length === 0} emptyText={t.records.noMeetings} />
      {meetings.map((meeting) => (
        <ItemRow
          key={meeting.id}
          icon={Calendar}
          title={meeting.title}
          subtitle={[dateTime(meeting.start), plural(meeting.attendeeCount, t.records.attendees)].filter(Boolean).join(' · ')}
          meta={(t.records.meetingStatus as Record<string, string>)[meeting.status] ?? meeting.status}
        />
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function formatSize(bytes?: number): string | undefined {
  if (!bytes) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FilesPanel({ record, refreshKey }: Readonly<PanelProps>) {
  const { t } = useI18n();
  const toast = useToast();
  const { date } = useDateFormat();
  const [uploading, setUploading] = useState(false);
  const { data, loading, error, reload } = useLoad(() => recordTabsApi.files(record), [record.kind, record.id, refreshKey]);
  const files = data ?? [];

  const upload = async () => {
    let picker: typeof import('expo-document-picker');
    try {
      // Loaded on demand so a build without the native module only loses this button.
      picker = await import('expo-document-picker');
    } catch {
      toast.error(t.records.uploadUnavailable);
      return;
    }
    const result = await picker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    setUploading(true);
    const res = await recordTabsApi.uploadFile(record, { name: asset.name, uri: asset.uri, mimeType: asset.mimeType });
    setUploading(false);
    if (res.success) {
      toast.success(t.records.uploadedToast);
      void reload();
    } else {
      toast.error(typeof res.error === 'string' ? res.error : t.records.uploadFailed);
    }
  };

  const confirmDelete = (id: string, name: string) => {
    Alert.alert(t.records.deleteFileTitle, interpolate(t.records.deleteFileMessage, { name }), [
      { text: t.common.cancel, style: 'cancel' },
      {
        text: t.common.delete,
        style: 'destructive',
        onPress: () => {
          void recordTabsApi.deleteFile(id).then((res) => {
            if (res.success) {
              toast.success(t.records.fileDeletedToast);
              void reload();
            } else {
              toast.error(t.records.deleteFileFailed);
            }
          });
        },
      },
    ]);
  };

  return (
    <View>
      {uploading ? <ActivityIndicator style={styles.spinner} /> : <AddButton label={t.records.uploadFile} onPress={() => void upload()} />}
      <PanelState loading={loading} error={error} empty={files.length === 0} emptyText={t.records.noFiles} />
      {files.map((file) => (
        <ItemRow
          key={file.id}
          icon={Paperclip}
          title={file.name}
          subtitle={[formatSize(file.size), date(file.createdAt)].filter(Boolean).join(' · ')}
          onPress={file.url ? () => void Linking.openURL(file.url as string) : undefined}
          onLongPress={() => confirmDelete(file.id, file.name)}
          right={
            <TouchableOpacity
              onPress={() => confirmDelete(file.id, file.name)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`${t.common.delete} ${file.name}`}
            >
              <Trash2 size={16} color="#9CA3AF" />
            </TouchableOpacity>
          }
        />
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export function AuditPanel({ record, refreshKey }: Readonly<PanelProps>) {
  const { t } = useI18n();
  const { dateTime } = useDateFormat();
  const { data, loading, error } = useLoad(() => recordTabsApi.auditLog(record), [record.kind, record.id, refreshKey]);
  const entries = data ?? [];
  return (
    <View>
      <PanelState loading={loading} error={error} empty={entries.length === 0} emptyText={t.records.noAudit} />
      {entries.map((entry) => (
        <ItemRow
          key={entry.id}
          icon={Users}
          title={entry.description || entry.action}
          subtitle={[entry.by, dateTime(entry.createdAt)].filter(Boolean).join(' · ')}
          body={entry.changes.map((change) => `${change.field}: ${change.from} → ${change.to}`).join('\n') || undefined}
        />
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export function ChatPanel({ record, refreshKey }: Readonly<PanelProps>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const toast = useToast();
  const { dateTime } = useDateFormat();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const { data, loading, error, reload } = useLoad(() => recordTabsApi.chat(record), [record.kind, record.id, refreshKey]);
  const messages: ChatMessage[] = data?.messages ?? [];

  const send = async () => {
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    const res = await recordTabsApi.sendChat(record, data?.channelId ?? null, content);
    setSending(false);
    if (res.success) {
      setDraft('');
      void reload();
    } else {
      toast.error(t.records.sendFailed);
    }
  };

  return (
    <View>
      <PanelState loading={loading} error={error} empty={messages.length === 0} emptyText={t.records.noMessages} />
      {messages.map((message) => (
        <View key={message.id} style={[styles.message, { backgroundColor: colors.secondary }]}>
          <Text style={[styles.messageAuthor, { color: colors.text }]}>
            {message.authorName || t.common.unknown}
            <Text style={[styles.messageTime, { color: colors.muted }]}>{`  ${dateTime(message.createdAt)}`}</Text>
          </Text>
          <Text style={[styles.messageText, { color: colors.text }]}>{message.content}</Text>
        </View>
      ))}
      <View style={[styles.composer, { borderColor: colors.divider }]}>
        <TextInput
          style={[styles.composerInput, { color: colors.text }]}
          value={draft}
          onChangeText={setDraft}
          placeholder={t.records.messagePlaceholder}
          placeholderTextColor={colors.muted}
          multiline
          accessibilityLabel={t.records.messagePlaceholder}
        />
        <TouchableOpacity
          onPress={() => void send()}
          disabled={!draft.trim() || sending}
          accessibilityRole="button"
          accessibilityLabel={t.records.send}
          style={styles.sendButton}
        >
          {sending ? <ActivityIndicator size="small" /> : <Send size={18} color={draft.trim() ? ACCENT : colors.muted} />}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  spinner: { paddingVertical: 24 },
  empty: { fontSize: 14, paddingVertical: 16 },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: 8,
    marginBottom: 8,
  },
  addButtonText: { fontSize: 14, fontWeight: '500' },
  item: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  itemIcon: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  itemText: { flex: 1, gap: 2 },
  itemTitle: { fontSize: 15, fontWeight: '500' },
  itemSub: { fontSize: 12 },
  itemBody: { fontSize: 13, marginTop: 4, lineHeight: 18 },
  itemMeta: { fontSize: 12 },
  message: { borderRadius: 10, padding: 10, marginBottom: 8 },
  messageAuthor: { fontSize: 13, fontWeight: '600' },
  messageTime: { fontSize: 11, fontWeight: '400' },
  messageText: { fontSize: 14, marginTop: 4, lineHeight: 20 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', borderWidth: 1, borderRadius: 10, paddingLeft: 12, marginTop: 8 },
  composerInput: { flex: 1, fontSize: 15, paddingVertical: 10, maxHeight: 120 },
  sendButton: { padding: 12 },
});
