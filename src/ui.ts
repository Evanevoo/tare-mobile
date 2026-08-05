/** The console's palette, carried onto the handset so they read as one product. */
export const T = {
  zinc: '#0E1214', face: '#171C1F', ink: '#EDEFEC', steel: '#8A959C',
  rule: '#242B2F', soft: '#1D2427', stamp: '#1D2427',
  bottle: '#3FB489', needle: '#F0654A', amber: '#D9A036',
  radius: 10, gap: 12,
  mono: process.env.EXPO_OS === 'ios' ? 'Menlo' : 'monospace',
} as const;

export const shipTone = (m: 'SHIP' | 'RETURN') => (m === 'SHIP' ? T.amber : T.bottle);
