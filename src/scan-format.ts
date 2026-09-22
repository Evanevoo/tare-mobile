export type ScanIntent = 'asset' | 'customer' | 'order';

export type ScanFormats = {
  barcode?: string;
  customerNumber?: string;
  orderNumber?: string;
};

/** Select the website-configured rule for the field the driver chose to scan. */
export function formatForScanIntent(intent: ScanIntent, formats: ScanFormats | null | undefined): string | undefined {
  if (intent === 'customer') return formats?.customerNumber;
  if (intent === 'order') return formats?.orderNumber;
  return formats?.barcode;
}
