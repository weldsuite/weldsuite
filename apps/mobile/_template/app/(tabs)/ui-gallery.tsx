import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Heart, Mail, Plus, Star, Trash2, Bell, Inbox } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@weldsuite/mobile-ui/components/Card';
import { Input } from '@weldsuite/mobile-ui/components/Input';
import { Textarea } from '@weldsuite/mobile-ui/components/Textarea';
import { SearchBar } from '@weldsuite/mobile-ui/components/SearchBar';
import { Badge } from '@weldsuite/mobile-ui/components/Badge';
import { Chip } from '@weldsuite/mobile-ui/components/Chip';
import { Avatar } from '@weldsuite/mobile-ui/components/Avatar';
import { Divider } from '@weldsuite/mobile-ui/components/Divider';
import { Spinner } from '@weldsuite/mobile-ui/components/Spinner';
import { Skeleton } from '@weldsuite/mobile-ui/components/Skeleton';
import { ProgressBar } from '@weldsuite/mobile-ui/components/ProgressBar';
import { Switch } from '@weldsuite/mobile-ui/components/Switch';
import { Checkbox } from '@weldsuite/mobile-ui/components/Checkbox';
import { RadioGroup } from '@weldsuite/mobile-ui/components/RadioGroup';
import { SegmentedControl } from '@weldsuite/mobile-ui/components/SegmentedControl';
import { Tabs } from '@weldsuite/mobile-ui/components/Tabs';
import { Select } from '@weldsuite/mobile-ui/components/Select';
import { ListItem } from '@weldsuite/mobile-ui/components/ListItem';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { Banner } from '@weldsuite/mobile-ui/components/Banner';
import { Sheet } from '@weldsuite/mobile-ui/components/Sheet';
import { Accordion } from '@weldsuite/mobile-ui/components/Accordion';

/**
 * UI Gallery — a Storybook-style preview of every @weldsuite/mobile-ui primitive.
 * Lives in the mobile _template so every scaffolded app ships with a living
 * component reference. Toggle light/dark with the button in the header.
 */
export default function UIGalleryScreen() {
  const { colors, theme, toggleTheme } = useTheme();
  const insets = useSafeAreaInsets();

  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [query, setQuery] = useState('');
  const [switchOn, setSwitchOn] = useState(true);
  const [checked, setChecked] = useState(true);
  const [radio, setRadio] = useState('weekly');
  const [segment, setSegment] = useState('list');
  const [tab, setTab] = useState('all');
  const [select, setSelect] = useState<string | null>(null);
  const [chipSelected, setChipSelected] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>{title}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={{ paddingBottom: insets.bottom + 48 }}
    >
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Text style={[styles.title, { color: colors.text }]}>UI Gallery</Text>
        <Button title={theme === 'dark' ? 'Light' : 'Dark'} variant="outline" size="sm" onPress={toggleTheme} />
      </View>

      <Section title="BUTTONS">
        <View style={styles.row}>
          <Button title="Primary" onPress={() => {}} />
          <Button title="Secondary" variant="secondary" onPress={() => {}} />
        </View>
        <View style={styles.row}>
          <Button title="Outline" variant="outline" onPress={() => {}} />
          <Button title="Ghost" variant="ghost" onPress={() => {}} />
        </View>
        <View style={styles.row}>
          <Button title="Destructive" variant="destructive" onPress={() => {}} />
          <Button title="Loading" loading onPress={() => {}} />
        </View>
        <View style={styles.row}>
          <Button title="With icon" leftIcon={<Plus size={16} color={colors.primaryForeground} />} onPress={() => {}} />
          <Button title="Small" size="sm" variant="secondary" onPress={() => {}} />
        </View>
        <Button title="Full width large" size="lg" fullWidth onPress={() => {}} />
        <View style={styles.row}>
          <IconButton icon={<Heart size={20} color={colors.text} />} accessibilityLabel="Like" />
          <IconButton icon={<Star size={20} color={colors.text} />} variant="solid" accessibilityLabel="Star" />
          <IconButton icon={<Mail size={20} color={colors.text} />} variant="outline" accessibilityLabel="Mail" />
        </View>
      </Section>

      <Section title="CARD">
        <Card>
          <CardHeader>
            <CardTitle>Monthly report</CardTitle>
            <CardDescription>Your performance for June 2026.</CardDescription>
          </CardHeader>
          <CardContent>
            <Text style={{ color: colors.text }}>Revenue is up 12% over last month.</Text>
          </CardContent>
          <CardFooter>
            <Button title="View" size="sm" onPress={() => {}} />
            <Button title="Dismiss" size="sm" variant="ghost" onPress={() => {}} />
          </CardFooter>
        </Card>
      </Section>

      <Section title="INPUTS">
        <Input label="Email" placeholder="you@example.com" value={text} onChangeText={setText} keyboardType="email-address" autoCapitalize="none" />
        <Input label="With error" placeholder="Required" error="This field is required" />
        <Textarea label="Notes" placeholder="Write something…" value={note} onChangeText={setNote} />
        <SearchBar value={query} onChangeText={setQuery} placeholder="Search…" />
      </Section>

      <Section title="BADGES & CHIPS">
        <View style={styles.wrap}>
          <Badge>Default</Badge>
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="success">Success</Badge>
          <Badge variant="warning">Warning</Badge>
          <Badge variant="destructive">Error</Badge>
          <Badge variant="outline">Outline</Badge>
        </View>
        <View style={styles.wrap}>
          <Chip label="Selectable" selected={chipSelected} onPress={() => setChipSelected((s) => !s)} />
          <Chip label="Removable" onRemove={() => {}} />
          <Chip label="Starred" leftIcon={<Star size={14} color={colors.text} />} />
        </View>
      </Section>

      <Section title="SELECTION CONTROLS">
        <Switch value={switchOn} onValueChange={setSwitchOn} label="Push notifications" />
        <Checkbox checked={checked} onChange={setChecked} label="I agree to the terms" />
        <RadioGroup
          value={radio}
          onValueChange={setRadio}
          options={[
            { label: 'Daily digest', value: 'daily' },
            { label: 'Weekly digest', value: 'weekly' },
            { label: 'Never', value: 'never' },
          ]}
        />
        <SegmentedControl
          value={segment}
          onValueChange={setSegment}
          options={[
            { label: 'List', value: 'list' },
            { label: 'Grid', value: 'grid' },
            { label: 'Board', value: 'board' },
          ]}
        />
        <Select
          label="Country"
          value={select}
          onValueChange={setSelect}
          placeholder="Choose a country…"
          options={[
            { label: 'Belgium', value: 'be' },
            { label: 'Netherlands', value: 'nl' },
            { label: 'Germany', value: 'de' },
          ]}
        />
      </Section>

      <Section title="TABS">
        <Tabs
          activeKey={tab}
          onChange={setTab}
          tabs={[
            { key: 'all', label: 'All' },
            { key: 'unread', label: 'Unread' },
            { key: 'archived', label: 'Archived' },
          ]}
        />
      </Section>

      <Section title="DISPLAY">
        <View style={styles.wrap}>
          <Avatar name="Gert van den Berg" />
          <Avatar name="Jane Doe" shape="square" />
          <Avatar source={{ uri: 'https://i.pravatar.cc/100' }} size={48} />
        </View>
        <Divider />
        <View style={[styles.row, { alignItems: 'center' }]}>
          <Spinner />
          <Spinner label="Loading…" />
        </View>
        <View style={{ gap: 8 }}>
          <Skeleton width="80%" height={14} />
          <Skeleton width="60%" height={14} />
          <Skeleton width={120} height={14} />
        </View>
        <ProgressBar value={0.45} />
        <ProgressBar indeterminate />
      </Section>

      <Section title="LIST">
        <Card>
          <ListItem title="Notifications" subtitle="Manage alerts" leftElement={<Bell size={20} color={colors.text} />} showChevron onPress={() => {}} divider />
          <ListItem title="Inbox" subtitle="3 unread" leftElement={<Inbox size={20} color={colors.text} />} rightElement={<Badge variant="destructive">3</Badge>} showChevron onPress={() => {}} divider />
          <ListItem title="Delete account" destructive leftElement={<Trash2 size={20} color={colors.destructive} />} onPress={() => {}} />
        </Card>
      </Section>

      <Section title="FEEDBACK">
        <Banner variant="info" title="Heads up">This is an informational message.</Banner>
        <Banner variant="success" title="Saved">Your changes were saved.</Banner>
        <Banner variant="warning" title="Careful">Double-check your tax settings.</Banner>
        <Banner variant="error" title="Error" onClose={() => {}}>Something went wrong.</Banner>
      </Section>

      <Section title="EMPTY STATE">
        <Card>
          <CardContent>
            <EmptyState
              icon={<Inbox size={40} color={colors.mutedForeground} />}
              title="No messages yet"
              description="When you receive messages they'll show up here."
              action={<Button title="Refresh" size="sm" variant="secondary" onPress={() => {}} />}
            />
          </CardContent>
        </Card>
      </Section>

      <Section title="ACCORDION">
        <Accordion
          items={[
            { key: 'a', title: 'What is WeldSuite?', content: <Text style={{ color: colors.mutedForeground }}>An all-in-one business platform.</Text> },
            { key: 'b', title: 'How is my data stored?', content: <Text style={{ color: colors.mutedForeground }}>Per-workspace, isolated databases.</Text> },
          ]}
        />
      </Section>

      <Section title="OVERLAYS">
        <Button title="Open bottom sheet" variant="secondary" onPress={() => setSheetOpen(true)} />
        <Sheet visible={sheetOpen} onClose={() => setSheetOpen(false)} title="Bottom sheet">
          <Text style={{ color: colors.text, marginBottom: 16 }}>
            Sheets slide up from the bottom and respect the safe area.
          </Text>
          <Button title="Close" fullWidth onPress={() => setSheetOpen(false)} />
        </Sheet>
      </Section>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  title: { fontSize: 30, fontWeight: '700' },
  section: { paddingHorizontal: 16, marginBottom: 28 },
  sectionTitle: { fontSize: 12, fontWeight: '700', letterSpacing: 0.6, marginBottom: 12 },
  sectionBody: { gap: 12 },
  row: { flexDirection: 'row', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' },
  wrap: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
});
