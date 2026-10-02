export interface Settings {
  apiBase: string;
  explorerBase: string;
  feePerKb: number;
}

const LS_SETTINGS = 'mnemonic-brc100-settings';

// Application fee policy: target about 100 sat/kB, allowing a narrow band.
export const MIN_FEE_PER_KB = 90;
export const MAX_FEE_PER_KB = 110;
export const FEE_TOLERANCE_PER_KB = 10;

export const DEFAULT_SETTINGS: Settings = {
  apiBase: 'https://api.whatsonchain.com/v1/bsv/main',
  explorerBase: 'https://whatsonchain.com/tx/',
  feePerKb: 100,
};

export const isHttps = (url: string) => /^https:\/\//i.test(url);

// Targets stay close to the 100 sat/kB default; invalid values fall back.
export function sanitizeFee(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isSafeInteger(n) || n < MIN_FEE_PER_KB || n > MAX_FEE_PER_KB) return DEFAULT_SETTINGS.feePerKb;
  return n;
}

/** Inclusive whole-satoshi fee band for the final serialized transaction. */
export function signedFeeBounds(size: number, targetPerKb: number): { minimum: number; preferred: number; maximum: number } {
  if (!Number.isSafeInteger(size) || size < 1 || !Number.isSafeInteger(targetPerKb) ||
    targetPerKb < MIN_FEE_PER_KB || targetPerKb > MAX_FEE_PER_KB) {
    throw new Error('Invalid signed transaction size or fee target.');
  }
  const bytes = BigInt(size);
  const minRate = BigInt(Math.max(MIN_FEE_PER_KB, targetPerKb - FEE_TOLERANCE_PER_KB));
  const maxRate = BigInt(Math.min(MAX_FEE_PER_KB, targetPerKb + FEE_TOLERANCE_PER_KB));
  const minimum = Math.max(1, Number(bytes * minRate / 1000n));
  const preferred = Number((bytes * BigInt(targetPerKb) + 999n) / 1000n);
  const maximum = Number((bytes * maxRate + 999n) / 1000n);
  if (![minimum, preferred, maximum].every(Number.isSafeInteger)) throw new Error('The transaction is too large to calculate a safe fee.');
  return { minimum, preferred, maximum };
}

export function loadSettings(): Settings {
  try {
    const stored = JSON.parse(localStorage.getItem(LS_SETTINGS) ?? '{}') ?? {};
    const merged = { ...DEFAULT_SETTINGS, ...stored };
    // A tampered localStorage must not smuggle in a javascript: URL.
    if (!isHttps(merged.apiBase)) merged.apiBase = DEFAULT_SETTINGS.apiBase;
    if (!isHttps(merged.explorerBase)) merged.explorerBase = DEFAULT_SETTINGS.explorerBase;
    merged.feePerKb = sanitizeFee(merged.feePerKb);
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings) {
  try {
    localStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
  } catch {
    // Storage blocked (private mode etc.); settings still apply for this session.
  }
}

export function explorerHref(settings: Settings, txid: string): string | null {
  const href = `${settings.explorerBase}${encodeURIComponent(txid)}`;
  return isHttps(href) ? href : null;
}
