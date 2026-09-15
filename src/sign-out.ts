export type HandoverResult = { handed: boolean; unsent: number };

/**
 * A normal sign-out must never abandon an unsent queue. Deliberate data loss
 * is handled separately by the explicit forced handover in Settings.
 */
export async function finishSignOut(
  handOver: () => Promise<HandoverResult>,
  signOut: () => Promise<unknown>,
): Promise<HandoverResult> {
  const result = await handOver();
  if (!result.handed) return result;

  await signOut();
  return result;
}
