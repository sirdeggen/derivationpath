import { describe, expect, it, vi } from 'vitest';
import { deriveKey, presetById, rootFromMnemonic, UNIQUE_TEMPLATES } from '../derive';
import { scanForUtxos, templatesForScan } from '../scan';
import type { Api } from '../net';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const root = rootFromMnemonic(MNEMONIC, '');
const centbee = presetById('centbee')!.template;

function scanApi(history: (address: string) => Promise<{ tx_hash: string }[]>, fundedAddress: string): Api {
  return {
    woc: {
      history,
      unspent: async (address: string) => address === fundedAddress
        ? [{ tx_hash: 'a'.repeat(64), tx_pos: 0, value: 10_000, height: 1 }]
        : [],
    },
    ordinals: { unspent: async () => [] },
  } as unknown as Api;
}

describe('recovery scan safety', () => {
  it('scans both Centbee receive and change, while retaining the old receive prefix', async () => {
    expect(centbee).toBe("m/44'/0/{chain}/{index}");
    expect(presetById('legacycentbee')?.template).toBe("m/44'/0/0/{index}");
    const receive = deriveKey(root, centbee, 0, 0);
    const change = deriveKey(root, centbee, 1, 0);
    expect(receive.path).toBe("m/44'/0/0/0");
    expect(change.path).toBe("m/44'/0/1/0");
    expect(change.address).not.toBe(receive.address);
    expect(deriveKey(root, presetById('legacycentbee')!.template, 0, 0).address).toBe(receive.address);

    const api = scanApi(async address => address === change.address ? [{ tx_hash: 'used' }] : [], change.address);
    const onHit = vi.fn();
    const summary = await scanForUtxos({
      api, root, templates: [centbee], includeChange: true,
      gapLimit: 1, startOffset: 0, maxPerChain: 5, onHit,
    });
    expect(summary.hits.map(h => h.path)).toEqual([change.path]);
    expect(summary.hits[0].balance).toBe(10_000);
    expect(onHit).toHaveBeenCalledTimes(1);
  });

  it('includes a custom selected path in an all-wallet scan exactly once', () => {
    const custom = "m/44'/236'/7'/{chain}/{index}";
    expect(templatesForScan(custom, false)).toEqual([custom]);
    expect(templatesForScan(custom, true)).toContain(custom);
    expect(templatesForScan(custom, true)).toHaveLength(UNIQUE_TEMPLATES.length + 1);
    expect(templatesForScan(centbee, true)).toHaveLength(UNIQUE_TEMPLATES.length);
  });

  it('counts already checked empty addresses toward a duplicate legacy prefix gap', async () => {
    const history = vi.fn(async () => []);
    const api = scanApi(history, '');
    const summary = await scanForUtxos({
      api, root, templates: [centbee, presetById('legacycentbee')!.template], includeChange: false,
      gapLimit: 1, startOffset: 0, maxPerChain: 5,
    });
    expect(summary.addressesChecked).toBe(1);
    expect(summary.cappedChains).toEqual([]);
    expect(history).toHaveBeenCalledTimes(1);
  });

  it('does not publish a found coin if a later lookup fails', async () => {
    const funded = deriveKey(root, centbee, 0, 0).address;
    const next = deriveKey(root, centbee, 0, 1).address;
    const onHit = vi.fn();
    const api = scanApi(async address => {
      if (address === next) throw new Error('lookup failed');
      return address === funded ? [{ tx_hash: 'used' }] : [];
    }, funded);

    await expect(scanForUtxos({
      api, root, templates: [centbee], includeChange: false,
      gapLimit: 1, startOffset: 0, maxPerChain: 5, onHit,
    })).rejects.toThrow('lookup failed');
    expect(onHit).not.toHaveBeenCalled();
  });

  it('does not publish a found coin if the scan is canceled at its last lookup', async () => {
    const funded = deriveKey(root, centbee, 0, 0).address;
    const next = deriveKey(root, centbee, 0, 1).address;
    const controller = new AbortController();
    const onHit = vi.fn();
    const api = scanApi(async address => {
      if (address === next) controller.abort();
      return address === funded ? [{ tx_hash: 'used' }] : [];
    }, funded);

    await expect(scanForUtxos({
      api, root, templates: [centbee], includeChange: false,
      gapLimit: 1, startOffset: 0, maxPerChain: 5, onHit,
      signal: controller.signal,
    })).rejects.toThrow('Scan stopped.');
    expect(onHit).not.toHaveBeenCalled();
  });

  it('reports an address-capped scan without publishing its partial hits', async () => {
    const funded = deriveKey(root, centbee, 0, 0).address;
    const onHit = vi.fn();
    const api = scanApi(async address => address === funded ? [{ tx_hash: 'used' }] : [], funded);
    const summary = await scanForUtxos({
      api, root, templates: [centbee], includeChange: false,
      gapLimit: 2, startOffset: 0, maxPerChain: 1, onHit,
    });
    expect(summary.hits).toHaveLength(1);
    expect(summary.cappedChains).toEqual([`${centbee} chain 0`]);
    expect(onHit).not.toHaveBeenCalled();
  });
});
