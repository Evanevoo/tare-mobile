import { View, Text, Pressable, FlatList } from 'react-native';
import { useStore } from '@/store';
import { pending } from '@/outbox';
import { T, shipTone, Screen, Surface, Btn, Dot, Eyebrow, Tag, Rise, mono } from '@/ui';

/**
 * The outbox, on screen.
 *
 * A driver will not trust an app that swallows their work silently. So the
 * queue is a real screen: every unsent scan is visible, the count is exact and
 * large, and pressing Sync twice is safe and says so.
 */
export default function Queue() {
  const { outbox, sync, syncing, online, lastError, lastSync, dispatch } = useStore();
  const unsent = pending(outbox);
  const sent = outbox.scans.filter((s) => s.state === 'SENT');

  const stateTone = (s: string) =>
    s === 'SENT' ? T.bottle : s === 'UPLOADING' ? T.amber : T.faint;

  return (
    <Screen intensity={0.7}>
      <FlatList
        data={[...unsent, ...sent]}
        keyExtractor={(s) => s.clientId}
        ListHeaderComponent={
          <View style={{ padding: 18, paddingTop: 46 }}>
            <Rise>
              <Surface level={3} tint={unsent.length ? 'rgba(224,164,58,0.10)' : undefined}>
                <View style={{ padding: 20 }}>
                  <Eyebrow>Waiting on this phone</Eyebrow>
                  <Text
                    style={[
                      mono(52, '800'),
                      { color: unsent.length ? T.amber : T.ink, marginTop: 10, letterSpacing: -2.5 },
                    ]}
                  >
                    {unsent.length}
                  </Text>
                  <Text style={{ color: T.steel, fontSize: 13.5, marginTop: 2 }}>
                    {unsent.length === 1 ? 'scan waiting to upload' : 'scans waiting to upload'}
                  </Text>

                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 16 }}>
                    <Dot tone={online ? T.bottle : T.needle} />
                    <Text style={{ color: T.faint, fontSize: 12.5 }}>
                      {online ? 'Connected' : 'No connection — nothing is lost'}
                    </Text>
                  </View>

                  {lastError && (
                    <View
                      style={{
                        marginTop: 14, padding: 12, borderRadius: T.radiusSm,
                        backgroundColor: 'rgba(240,101,74,0.10)',
                        borderWidth: 1, borderColor: 'rgba(240,101,74,0.26)',
                      }}
                    >
                      <Text style={{ color: T.needle, fontSize: 13, lineHeight: 19 }}>{lastError}</Text>
                    </View>
                  )}

                  <Btn
                    label={unsent.length ? `Sync ${unsent.length}` : 'Nothing to sync'}
                    style={{ marginTop: 18 }}
                    busy={syncing}
                    disabled={!unsent.length}
                    onPress={() => sync()}
                  />

                  <Text style={{ color: T.faint, fontSize: 12, marginTop: 14, lineHeight: 18 }}>
                    Syncing twice is safe. The server matches on order, barcode and direction, so a
                    repeat upload posts nothing new.
                    {lastSync ? `\nLast sync ${new Date(lastSync).toLocaleString()}.` : ''}
                  </Text>
                </View>
              </Surface>
            </Rise>
          </View>
        }
        ListEmptyComponent={
          <Text
            style={{
              color: T.faint, fontSize: 13.5, textAlign: 'center',
              paddingTop: 16, paddingHorizontal: 40, lineHeight: 20,
            }}
          >
            The queue is empty. Every scan has reached the server.
          </Text>
        }
        ListFooterComponent={
          sent.length ? (
            <Pressable
              onPress={() => dispatch({ type: 'CLEAR_SENT' })}
              style={{ padding: 26, alignItems: 'center' }}
            >
              <Text style={{ color: T.faint, fontSize: 13.5, fontWeight: '600' }}>
                Clear {sent.length} uploaded
              </Text>
            </Pressable>
          ) : null
        }
        renderItem={({ item }) => (
          <View
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 12,
              paddingHorizontal: 18, paddingVertical: 14,
              borderBottomWidth: 1, borderBottomColor: T.soft,
              opacity: item.state === 'SENT' ? 0.42 : 1,
            }}
          >
            <View style={{ width: 3, height: 28, borderRadius: 2, backgroundColor: shipTone(item.mode) }} />
            <View style={{ flex: 1 }}>
              <Text style={[mono(15, '600'), { color: T.ink }]}>{item.barcode}</Text>
              <Text style={{ color: T.faint, fontSize: 11.5, marginTop: 2 }}>
                {item.orderNumber} · {item.mode === 'SHIP' ? 'Ship out' : 'Return in'}
              </Text>
            </View>
            <Tag label={item.state} tone={stateTone(item.state)} />
          </View>
        )}
      />
    </Screen>
  );
}
