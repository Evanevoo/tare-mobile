import { Tabs } from 'expo-router';
import { View } from 'react-native';
import { useStore } from '@/store';
import { pending } from '@/outbox';
import { T, Icon, ICON } from '@/ui';

/**
 * Five tabs, and no more.
 *
 * The old app was a flat pile of twenty-five stack routes reached from a
 * dashboard wall, which is why a new driver needed training. This encodes the
 * two jobs instead: Delivery is customer plus order plus SHIP/RETURN, Warehouse
 * is location plus Full/Empty. If a screen does not belong to one of the five,
 * it is a stack pushed on top of one — never a sixth tab.
 *
 * Labels are always shown. Icon-only navigation costs nothing to build and
 * costs a driver ten seconds every time they guess wrong.
 */
export default function TabLayout() {
  const outbox = useStore((s) => s.outbox);
  const unsent = pending(outbox).length;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: T.brandLit,
        tabBarInactiveTintColor: T.faint,
        tabBarStyle: {
          backgroundColor: 'rgba(10,14,16,0.96)',
          borderTopColor: T.rule,
          borderTopWidth: 1,
          height: 88,
          paddingTop: 8,
          paddingBottom: 30,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '700', marginTop: 2 },
        tabBarItemStyle: { paddingVertical: 2 },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color }) => <Icon name="home" size={ICON.lg} color={color} />,
        }}
      />
      <Tabs.Screen
        name="delivery"
        options={{
          title: 'Delivery',
          tabBarIcon: ({ color }) => <Icon name="truck" size={ICON.lg} color={color} />,
        }}
      />
      <Tabs.Screen
        name="warehouse"
        options={{
          title: 'Warehouse',
          tabBarIcon: ({ color }) => <Icon name="package" size={ICON.lg} color={color} />,
        }}
      />
      <Tabs.Screen
        name="activity"
        options={{
          title: 'Activity',
          tabBarBadge: unsent || undefined,
          tabBarBadgeStyle: {
            backgroundColor: T.amber, color: T.onBrand, fontSize: 10.5, fontWeight: '800',
          },
          tabBarIcon: ({ color }) => <Icon name="clock" size={ICON.lg} color={color} />,
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: 'More',
          tabBarIcon: ({ color }) => <Icon name="menu" size={ICON.lg} color={color} />,
        }}
      />
    </Tabs>
  );
}
