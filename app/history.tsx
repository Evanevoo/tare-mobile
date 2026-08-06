import { View, Text, SectionList } from 'react-native';
import { useStore } from '@/store';
import { T, Screen, Surface, Eyebrow, Rise, shipTone, tint } from '@/ui';

/**
 * Every scan this phone has made, newest first.
 *
 * The driver's question at 16:50 is "did I already do that bottle at Acme?"
 * — answered here without signal, from the outbox itself. SENT rows prove
 * the server has them; QUEUED rows are a promise this phone still owes.
 * Nothing is ever deleted from view by syncing: history is what happened,
 * not what remains to upload.
 */
export default function History() {
  const { boot, outbox } = useStore();

  const nameBy = new Map((boot?.customers ?? []).map((c) => [c.customerListId, c.name]));

  const byDay = new Map<string, typeof outbox.scans>();
  for (const s of [...outbox.scans].sort((a, b) => b.scannedAt.localeCompare(a.scannedAt))) {
    const day = s.scannedAt.slice(0, 10);
    const list = byDay.get(day) ?? [];
    list.push(s);
    byDay.set(day, list);
  }
  const sections = [...byDay.entries()].map(([day, data]) => ({
    title: dayLabel(day), data,
  }));

  const unsent = outbox.scans.filter((s) => s.state !== 'SENT').length;

  return (
    <Screen intensity={0.7}>
      <View style={{ flex: 1, paddingHorizontal: 18, paddingTop: 14 }}>
        <Rise>
          <Text style={{ color: T.ink, fontSize: 30, fontWeight: '700', letterSpacing: -1.1 }}>
            History
          </Text>
          <Text style={{ color: T.faint, fontSize: 13, marginTop: 4 }}>
            {outbox.scans.length} scan{outbox.scans.length === 1 ? '' : 's'} on this phone
            {unsent ? ` · ${unsent} not uploaded yet` : ' · all on the server'}
          </Text>
        </Rise>

        {sections.length === 0 ? (
          <Rise delay={60} style={{ marginTop: 26 }}>
            <Surface>
              <View style={{ padding: 22 }}>
                <Text style={{ color: T.ink, fontSize: 15, fontWeight: '600' }}>Nothing scanned yet</Text>
                <Text style={{ color: T.faint, fontSize: 13, marginTop: 6, lineHeight: 19 }}>
                  The moment you scan an order, every beep lands here — even with no signal,
                  even after it uploads.
                </Text>
              </View>
            </Surface>
          </Rise>
        ) : (
          <SectionList
            style={{ marginTop: 10 }}
            contentContainerStyle={{ paddingBottom: 44 }}
            sections={sections}
            keyExtractor={(s) => s.clientId}
            stickySectionHeadersEnabled={false}
            renderSectionHeader={({ section }) => (
              <Eyebrow style={{ marginTop: 18, marginBottom: 8 }}>{section.title}</Eyebrow>
            )}
            renderItem={({ item: s }) => (
              <View style={{
                flexDirection: 'row', alignItems: 'center', gap: 12,
                paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: tint(0.05),
              }}>
                {/* The direction is a bar, not a word — it reads at walking pace. */}
                <View style={{ width: 3, alignSelf: 'stretch', borderRadius: 2, backgroundColor: shipTone(s.mode) }} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: T.ink, fontSize: 14.5, fontWeight: '600', fontVariant: ['tabular-nums'] }} numberOfLines={1}>
                    {s.barcode}
                  </Text>
                  <Text style={{ color: T.faint, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
                    {s.mode === 'SHIP' ? 'Out' : 'Back'} · order {s.orderNumber}
                    {nameBy.get(s.customerListId) ? ` · ${nameBy.get(s.customerListId)}` : ''}
                  </Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={{ color: T.steel, fontSize: 12, fontVariant: ['tabular-nums'] }}>
                    {s.scannedAt.slice(11, 16)}
                  </Text>
                  <Text style={{
                    fontSize: 10.5, fontWeight: '700', marginTop: 3, letterSpacing: 0.4,
                    color: s.state === 'SENT' ? T.bottle : s.state === 'UPLOADING' ? T.steel : T.amber,
                  }}>
                    {s.state === 'SENT' ? 'ON SERVER' : s.state === 'UPLOADING' ? 'UPLOADING' : 'ON PHONE'}
                  </Text>
                </View>
              </View>
            )}
          />
        )}
      </View>
    </Screen>
  );
}

function dayLabel(day: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const yest = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  if (day === today) return 'Today';
  if (day === yest) return 'Yesterday';
  const d = new Date(`${day}T12:00:00Z`);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
