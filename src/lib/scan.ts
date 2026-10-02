import type { HD, PrivateKey } from '@bsv/sdk';
import type { Api } from './net';
import { UNIQUE_TEMPLATES, deriveKey, templateHasChain } from './derive';
import { filterSpendable, protectedSet } from './tokens';

export interface FoundUtxo {
  txid: string;
  vout: number;
  satoshis: number;
  address: string;
  path: string;
  privateKey: PrivateKey;
}

export interface AddressHit {
  template: string;
  path: string;
  chain: number;
  index: number;
  address: string;
  balance: number;
  utxos: FoundUtxo[];
  protectedCount: number;
}

export interface ScanOptions {
  api: Api;
  root: HD;
  templates: string[];
  includeChange: boolean;
  /** Stop a chain after this many consecutive addresses with no history. */
  gapLimit: number;
  startOffset: number;
  /** Hard cap per chain, so a busy wallet can't scan forever. */
  maxPerChain: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  /** Called after a successful uncapped scan, never during a partial scan. */
  onHit?: (hit: AddressHit) => void;
}

export interface ScanSummary {
  hits: AddressHit[];
  addressesChecked: number;
  usedAddresses: number;
  protectedTotal: number;
  cappedChains: string[];
}

/** Include the selected custom path when scanning every known preset. */
export function templatesForScan(selectedTemplate: string, all: boolean): string[] {
  return all ? [...new Set([...UNIQUE_TEMPLATES, selectedTemplate])] : [selectedTemplate];
}

/**
 * Gap-limit discovery across one or more templates and chains. Any network
 * failure aborts the whole scan by design: a partial scan presented as
 * "complete" would hide coins from the sweep. Hits are published only after
 * the scan returns; chains stopped by the address cap are reported separately.
 */
export async function scanForUtxos(opts: ScanOptions): Promise<ScanSummary> {
  const { api, root, signal, onProgress, onHit } = opts;
  const hits: AddressHit[] = [];
  // Presets can overlap. Keep history usage so a duplicate still advances the
  // current chain's gap counter without another network request.
  const seen = new Map<string, boolean>();
  const cappedChains: string[] = [];
  let addressesChecked = 0;
  let usedAddresses = 0;
  let protectedTotal = 0;

  for (const template of opts.templates) {
    const chains = templateHasChain(template) && opts.includeChange ? [0, 1] : [0];
    for (const chain of chains) {
      let consecutiveUnused = 0;
      let index = opts.startOffset;
      let scanned = 0;
      while (consecutiveUnused < opts.gapLimit) {
        if (signal?.aborted) throw new Error('Scan stopped.');
        if (scanned >= opts.maxPerChain) {
          cappedChains.push(`${template} chain ${chain}`);
          break;
        }
        const key = deriveKey(root, template, chain, index);
        index++;
        scanned++;
        const previouslyUsed = seen.get(key.address);
        if (previouslyUsed !== undefined) {
          consecutiveUnused = previouslyUsed ? 0 : consecutiveUnused + 1;
          continue;
        }
        addressesChecked++;
        onProgress?.(`Checking ${key.path}: ${key.address}`);

        const history = await api.woc.history(key.address);
        seen.set(key.address, history.length > 0);
        if (!history.length) {
          consecutiveUnused++;
          continue;
        }
        consecutiveUnused = 0;
        usedAddresses++;

        const raw = await api.woc.unspent(key.address);
        if (!raw.length) continue;
        const utxos = raw.map(u => ({ txid: u.tx_hash, vout: u.tx_pos, satoshis: u.value }));
        const { spendable, protectedCount } = filterSpendable(utxos, await protectedSet(api, key.address));
        protectedTotal += protectedCount;
        if (!spendable.length && !protectedCount) continue;

        const hit: AddressHit = {
          template, path: key.path, chain, index: key.index, address: key.address,
          balance: spendable.reduce((s, u) => s + u.satoshis, 0),
          utxos: spendable.map(u => ({ ...u, address: key.address, path: key.path, privateKey: key.privateKey })),
          protectedCount,
        };
        hits.push(hit);
      }
    }
  }
  if (signal?.aborted) throw new Error('Scan stopped.');
  if (!cappedChains.length) for (const hit of hits) onHit?.(hit);
  return { hits, addressesChecked, usedAddresses, protectedTotal, cappedChains };
}
