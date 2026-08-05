import { View, Text, Pressable, FlatList, ActivityIndicator } from 'react-native';
import { useStore } from '@/store';
import { pending } from '@/outbox';
import { T, shipTone } from '@/ui';

/**
 * The outbox, on screen.
 *
 * A driver will not trust an app that swallows their work silently. So the
 * queue is a real screen: every unsent scan is visible, the count is exact,
 * and pressing Sync twice is safe and says so.
 */
export default function Queue() {
  const { outbox, sync, syncing, online, lastError, lastSync, dispatch } = useStore();
  const unsent = pending(outbox);
  const sent = outbox.scans.filter((s) => s.state === 'SENT');

  return (
    <View style={{ flex: 1, backgroundColor: T.zinc }}>
      <View style={{ padding: 16, backgroundColor: T.face, borderBottomWidth: 1, borderBottomColor: T.rule }}>
        <Text style={{ color: T.ink, fontSize: 34, fontWeight: '800', fontFamily: T.mono }}>
          {unsent.length}
        </Text>
        <Text style={{ color: T.steel, fontSize: 13, marginTop: -2 }}>
          {unsent.length === 1 ? 'scan waiting to upload' : 'scans waiting to upload'}
        </Text>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 10 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: online ? T.bottle : T.needle }} />
          <Text style={{ color: T.steel, fontSize: 12 }}>
            {online ? 'Connected' : 'No connection — nothing is lost'}
          </Text>
        </View>

        {lastError && (
          <Text style={{ color: T.needle, fontSize: 12.5, marginTop: 8 }}>{lastError}</Text>
        )}

        <Pressable
          disabled={!unsent.length || syncing}
          onPress={() => sync()}
          style={{
            height: 48, borderRadius: T.radius, backgroundColor: T.bottle, marginTop: 14,
            alignItems: 'center', justifyContent: 'center',
            opacity: !unsent.length || syncing ? 0.4 : 1,
          }}
        >
          {syncing
            ? <ActivityIndicator color="#fff" />
            : <Text style={{ color: '#fff', fontSize: 15.5, fontWeight: '700' }}>
                {unsent.length ? `Sync ${unsent.length}` : 'Nothing to sync'}
              </Text>}
        </Pressable>

        <Text style={{ color: T.steel, fontSize: 11.5, marginTop: 9, lineHeight: 16 }}>
          Syncing twice is safe. The server matches on order, barcode and direction, so a
          repeat upload posts nothing new.
          {lastSync ? `\nLast sync ${new Date(lastSync).toLocaleString()}.` : ''}
        </Text>
      </View>

      <FlatList
        data={[...unsent, ...sent]}
        keyExtractor={(s) => s.clientId}
        ListEmptyComponent={
          <Text style={{ color: T.steel, fontSize: 13, textAlign: 'center', paddingTop: 40 }}>
            The queue is empty. Every scan has reached the server.
          </Text>
        }
        ListFooterComponent={
          sent.length ? (
            <Pressable
              onPress={() => dispatch({ type: 'CLEAR_SENT' })}
              style={{ padding: 22, alignItems: 'center' }}
            >
              <Text style={{ color: T.steel, fontSize: 13 }}>Clear {sent.length} uploaded</Text>
            </Pressable>
          ) : null
        }
        renderItem={({ item }) => (
          <View style={{
            flexDirection: 'row', alignItems: 'center', gap: 10,
            paddingHorizontal: 16, paddingVertical: 12,
            borderBottomWidth: 1, borderBottomColor: T.soft,
            opacity: item.state === 'SENT' ? 0.45 : 1,
          }}>
            <View style={{ width: 3, height: 24, borderRadius: 2, backgroundColor: shipTone(item.mode) }} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: T.ink, fontSize: 15, fontFamily: T.mono }}>{item.barcode}</Text>
              <Text style={{ color: T.steel, fontSize: 11.5, marginTop: 1 }}>
                {item.orderNumber} · {item.mode === 'SHIP' ? 'Ship out' : 'Return in'}
              </Text>
            </View>
            <Text style={{
              color: item.state === 'SENT' ? T.bottle : item.state === 'UPLOADING' ? T.amber : T.steel,
              fontSize: 10, fontWeight: '800', letterSpacing: 0.6,
            }}>
              {item.state}
            </Text>
          </View>
        )}
      />
    </View>
  );
}
