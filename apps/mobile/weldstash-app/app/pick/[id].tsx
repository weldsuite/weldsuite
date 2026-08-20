import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import type { PickListItemRow } from '@weldsuite/app-api-client/domains/pick-lists';
import { appApi } from '@/services/app-api';
import { useHardwareBarcodeScan } from '@/hooks/useHardwareBarcodeScan';
import { normalizeBarcode } from '@/utils/barcode';
import { weldstashKeys } from '@/lib/query-client';
import { useWeldstashPickList } from '@/hooks/use-weldstash-queries';

const TERMINAL = new Set(['picked', 'partial', 'short', 'skipped']);

export default function PickDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { error: showError, success } = useToast();
  const queryClient = useQueryClient();

  const pickQuery = useWeldstashPickList(id);
  const list = pickQuery.data?.data ?? null;
  const loading = pickQuery.isPending && !list;

  const [busy, setBusy] = useState(false);
  const [qty, setQty] = useState('');
  const [scannedLocation, setScannedLocation] = useState<string | null>(null);
  const [senderId, setSenderId] = useState('');
  const [methodCode, setMethodCode] = useState('');
  const [weightKg, setWeightKg] = useState('1');
  const [senders, setSenders] = useState<Array<{ id: number; name: string; enabled: boolean; isDefault: boolean }>>([]);
  const [methods, setMethods] = useState<Array<{ code: string; name: string; enabled: boolean; isDefault: boolean }>>([]);
  const [sendcloudConnected, setSendcloudConnected] = useState(false);

  const items = list?.items ?? [];
  const current = useMemo(
    () => items.find((item) => !TERMINAL.has(item.status ?? 'pending')) ?? null,
    [items],
  );
  const needsLocation = Boolean(current?.locationId);
  const scanPhase: 'location' | 'product' | 'done' =
    !current ? 'done' : needsLocation && !scannedLocation ? 'location' : 'product';

  useEffect(() => {
    if (!current) return;
    setQty(String(current.quantityRequired ?? 1));
    // Only reset when the active line changes — not on background refetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  const refresh = useCallback(async () => {
    if (!id) return;
    setScannedLocation(null);
    await queryClient.invalidateQueries({ queryKey: weldstashKeys.pickList(id) });
    await queryClient.invalidateQueries({ queryKey: weldstashKeys.pickLists() });
  }, [id, queryClient]);

  useEffect(() => {
    let cancelled = false;
    void appApi.sendcloud
      .get()
      .then((res) => {
        if (cancelled) return;
        const data = res.data;
        setSendcloudConnected(Boolean(data.connected));
        const nextSenders = (data.senders ?? []).filter((row) => row.enabled);
        const nextMethods = (data.methods ?? []).filter((row) => row.enabled);
        setSenders(nextSenders);
        setMethods(nextMethods);
        const defaultSender = nextSenders.find((row) => row.isDefault) ?? nextSenders[0];
        const defaultMethod = nextMethods.find((row) => row.isDefault) ?? nextMethods[0];
        if (defaultSender) setSenderId(String(defaultSender.id));
        if (defaultMethod) setMethodCode(defaultMethod.code);
      })
      .catch(() => {
        if (!cancelled) setSendcloudConnected(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const confirmLine = useCallback(
    async (item: PickListItemRow, productBarcode: string, locationBarcode?: string, short = false) => {
      if (!id) return;
      setBusy(true);
      try {
        const quantity = short ? Number(qty || 0) : Number(qty || item.quantityRequired || 0);
        await appApi.pickLists.pickItem(id, item.id, {
          quantity,
          productBarcode,
          locationBarcode,
          short,
        });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        await refresh();
      } catch (err) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        showError((err as Error).message || 'Pick failed');
      } finally {
        setBusy(false);
      }
    },
    [id, refresh, qty, showError],
  );

  useHardwareBarcodeScan((code) => {
    const normalized = normalizeBarcode(code);
    if (!normalized || !current || busy) return;
    if (scanPhase === 'location') {
      setScannedLocation(normalized);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      return;
    }
    void confirmLine(current, normalized, scannedLocation ?? undefined);
  });

  const runAction = async (fn: () => Promise<unknown>, ok: string) => {
    if (!id) return;
    setBusy(true);
    try {
      await fn();
      success(ok);
      await refresh();
    } catch (err) {
      showError((err as Error).message || ok);
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <ActivityIndicator color={colors.text} />
      </View>
    );
  }

  if (!list) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <Text style={{ color: colors.text }}>Could not load pick list</Text>
      </View>
    );
  }

  const allPicked = !current;
  const status = list.status;

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.background }]} contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => router.back()}>
          <Text style={{ color: colors.text, fontSize: 16 }}>Back</Text>
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]}>{list.pickListNumber}</Text>
        <Text style={[styles.meta, { color: colors.muted }]}>
          {status.replace('_', ' ')} · {list.pickedItems ?? 0}/{list.totalItems ?? 0} lines
        </Text>
      </View>

      {status === 'assigned' || status === 'pending' ? (
        <View style={styles.pad}>
          <Button title="Start pick" onPress={() => runAction(() => appApi.pickLists.start(id!), 'Pick started')} loading={busy} />
        </View>
      ) : null}

      {current && (status === 'in_progress' || status === 'assigned' || status === 'pending') ? (
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.divider }]}>
          <Text style={[styles.kicker, { color: colors.muted }]}>
            Line {(current.pickSequence ?? 0)} · scan {scanPhase}
          </Text>
          <Text style={[styles.itemName, { color: colors.text }]}>{current.name}</Text>
          <Text style={[styles.meta, { color: colors.muted }]}>
            SKU {current.sku || '—'} · Location {current.locationCode || 'unlocated'} · Qty {current.quantityRequired}
          </Text>
          {scannedLocation ? (
            <Text style={[styles.meta, { color: colors.text }]}>Location scanned: {scannedLocation}</Text>
          ) : null}
          <Text style={[styles.kicker, { color: colors.muted, marginTop: 16 }]}>Quantity</Text>
          <TextInput
            value={qty}
            onChangeText={setQty}
            keyboardType="number-pad"
            style={[styles.input, { color: colors.text, borderColor: colors.divider }]}
          />
          <View style={{ marginTop: 12, gap: 8 }}>
            <Button
              title="Mark short"
              variant="secondary"
              disabled={busy}
              onPress={() => void confirmLine(current, current.sku || current.name, scannedLocation ?? undefined, true)}
            />
          </View>
        </View>
      ) : null}

      {allPicked && status === 'in_progress' ? (
        <View style={styles.pad}>
          <Button title="Complete pick" onPress={() => runAction(() => appApi.pickLists.complete(id!), 'Pick completed')} loading={busy} />
        </View>
      ) : null}

      {status === 'completed' ? (
        <View style={styles.pad}>
          <Button title="Pack" onPress={() => runAction(() => appApi.pickLists.pack(id!), 'Packed')} loading={busy} />
        </View>
      ) : null}

      {status === 'packed' ? (
        <View style={styles.pad}>
          {!sendcloudConnected ? (
            <Text style={{ color: colors.muted, marginBottom: 8 }}>
              Connect Sendcloud in Settings → Integrations before shipping.
            </Text>
          ) : (
            <View style={{ gap: 8, marginBottom: 12 }}>
              <Text style={{ color: colors.muted }}>Sender id</Text>
              <TextInput
                value={senderId}
                onChangeText={setSenderId}
                keyboardType="number-pad"
                style={[styles.input, { color: colors.text, borderColor: colors.divider }]}
              />
              {senders.map((sender) => (
                <Pressable key={sender.id} onPress={() => setSenderId(String(sender.id))}>
                  <Text style={{ color: senderId === String(sender.id) ? colors.text : colors.muted }}>
                    {sender.name}
                  </Text>
                </Pressable>
              ))}
              <Text style={{ color: colors.muted }}>Parcel type</Text>
              {methods.map((method) => (
                <Pressable key={method.code} onPress={() => setMethodCode(method.code)}>
                  <Text style={{ color: methodCode === method.code ? colors.text : colors.muted }}>
                    {method.name}
                  </Text>
                </Pressable>
              ))}
              <Text style={{ color: colors.muted }}>Weight (kg)</Text>
              <TextInput
                value={weightKg}
                onChangeText={setWeightKg}
                keyboardType="decimal-pad"
                style={[styles.input, { color: colors.text, borderColor: colors.divider }]}
              />
            </View>
          )}
          <Button
            title="Send parcel"
            disabled={!sendcloudConnected || !senderId || !methodCode || busy}
            onPress={() =>
              runAction(async () => {
                const result = await appApi.pickLists.ship(id!, {
                  senderId: Number(senderId),
                  shippingOptionCode: methodCode,
                  weightKg: Number(weightKg),
                });
                const trackingUrl = result.data?.trackingUrl;
                if (trackingUrl) void Linking.openURL(trackingUrl);
              }, 'Parcel sent')
            }
            loading={busy}
          />
        </View>
      ) : null}

      <View style={styles.pad}>
        <Text style={[styles.kicker, { color: colors.muted }]}>Lines</Text>
        {items.map((item) => (
          <View key={item.id} style={[styles.line, { borderColor: colors.divider }]}>
            <Text style={{ color: colors.text, fontWeight: '600' }}>{item.name}</Text>
            <Text style={{ color: colors.muted }}>
              {item.status} · {item.quantityPicked ?? 0}/{item.quantityRequired} · {item.locationCode || 'unlocated'}
            </Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { paddingHorizontal: 16, paddingBottom: 12, gap: 6 },
  title: { fontSize: 28, fontWeight: '700' },
  meta: { fontSize: 14, textTransform: 'capitalize' },
  pad: { paddingHorizontal: 16, marginBottom: 16 },
  card: { marginHorizontal: 16, marginBottom: 16, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 16 },
  kicker: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4 },
  itemName: { fontSize: 20, fontWeight: '700', marginTop: 6 },
  input: { marginTop: 8, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 18 },
  line: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
});
