export type ScanAssist = {
  tone: 'ready' | 'warning';
  title: string;
  detail: string;
};

/** Plain, actionable recovery guidance for the live scanner. */
export function scanAssist(struggling: boolean, torch: boolean): ScanAssist {
  if (!struggling) {
    return { tone: 'ready', title: 'Aim at the barcode', detail: 'We’ll confirm it before adding.' };
  }
  if (!torch) {
    return { tone: 'warning', title: 'Low light? Turn on flash', detail: 'Or use Read from photo.' };
  }
  return { tone: 'ready', title: 'Still struggling?', detail: 'Use Read from photo.' };
}
