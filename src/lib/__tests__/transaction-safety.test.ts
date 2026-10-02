import { describe, expect, it } from 'vitest';
import { P2PKH, PrivateKey, Script, Spend, Transaction } from '@bsv/sdk';
import type { Api } from '../net';
import { MAX_FEE_PER_KB, MIN_FEE_PER_KB, sanitizeFee, signedFeeBounds } from '../settings';
import { buildP2pkhTransaction } from '../tx';

const key = PrivateKey.fromRandom();
const address = key.toAddress().toString();
const recipient = PrivateKey.fromRandom().toAddress().toString();
const otherRecipient = PrivateKey.fromRandom().toAddress().toString();

function coin(satoshis: number) {
  const source = new Transaction();
  source.addInput({ sourceTXID: '00'.repeat(32), sourceOutputIndex: 0, unlockingScript: new Script() });
  source.addOutput({ lockingScript: new P2PKH().lock(address), satoshis });
  const txid = source.id('hex');
  const api = { woc: { txHex: async () => source.toHex() } } as unknown as Api;
  const input = { txid, vout: 0, satoshis, address, privateKey: key };
  return { api, input, source };
}

describe('local transaction safety', () => {
  it('handles signature-length fee boundaries for deterministic keys', async () => {
    const destination = PrivateKey.fromHex('44'.repeat(32)).toAddress().toString();
    // Key 46 previously oscillated between 19 and 20 sats and failed after
    // eight re-signs. The surrounding keys exercise adjacent DER lengths.
    for (let n = 1; n <= 128; n++) {
      const sourceKey = PrivateKey.fromHex(n.toString(16).padStart(64, '0'));
      const sourceAddress = sourceKey.toAddress().toString();
      const source = new Transaction();
      source.addInput({ sourceTXID: '00'.repeat(32), sourceOutputIndex: 0, unlockingScript: new Script() });
      source.addOutput({ lockingScript: new P2PKH().lock(sourceAddress), satoshis: 100_000 });
      const txid = source.id('hex');
      const api = { woc: { txHex: async () => source.toHex() } } as unknown as Api;
      try {
        const built = await buildP2pkhTransaction({
          api, inputs: [{ txid, vout: 0, satoshis: 100_000, address: sourceAddress, privateKey: sourceKey }],
          outputs: [], changeAddress: destination, feePerKb: 100,
        });
        const { minimum, maximum } = signedFeeBounds(built.size, 100);
        expect(built.fee).toBeGreaterThanOrEqual(minimum);
        expect(built.fee).toBeLessThanOrEqual(maximum);
      } catch (error) {
        throw new Error(`Source key ${n}: ${(error as Error).message}`);
      }
    }
  });

  it('keeps the actual signed fee near its target and commits to every output', async () => {
    const { api, input, source } = coin(100_000);
    const built = await buildP2pkhTransaction({
      api, inputs: [input], outputs: [{ address: recipient, satoshis: 40_000 }],
      changeAddress: address, feePerKb: 100,
    });
    const { minimum, maximum } = signedFeeBounds(built.size, 100);
    expect(built.fee).toBeGreaterThanOrEqual(minimum);
    expect(built.fee).toBeLessThanOrEqual(maximum);
    expect(built.tx.outputs.length).toBeGreaterThan(0);
    expect(built.tx.outputs.every(o => typeof o.satoshis === 'number' && Number.isSafeInteger(o.satoshis) && o.satoshis > 0)).toBe(true);
    expect(built.tx.inputs[0].unlockingScript?.chunks[0]?.data?.at(-1)).toBe(0x41); // FORKID | ALL

    const original = source.outputs[0];
    const spend = (outputs: Transaction['outputs']) => new Spend({
      sourceTXID: input.txid, sourceOutputIndex: 0, sourceSatoshis: original.satoshis!,
      lockingScript: original.lockingScript, transactionVersion: built.tx.version,
      otherInputs: [], outputs, inputIndex: 0,
      unlockingScript: built.tx.inputs[0].unlockingScript!,
      inputSequence: built.tx.inputs[0].sequence ?? 0xffffffff,
      lockTime: built.tx.lockTime,
    });
    expect(spend(built.tx.outputs).validate()).toBe(true);
    const altered = built.tx.outputs.map(o => ({ ...o }));
    altered[0].lockingScript = new P2PKH().lock(otherRecipient);
    let validAfterRedirection = false;
    try { validAfterRedirection = spend(altered).validate(); } catch { /* Invalid scripts may throw. */ }
    expect(validAfterRedirection).toBe(false);
  });

  it('allows a large transaction to pay more than 100 sats total and a rate just above 100', async () => {
    const sources = new Map<string, Transaction>();
    const inputs = Array.from({ length: 8 }, (_, index) => {
      const source = new Transaction();
      source.addInput({ sourceTXID: (index + 1).toString(16).padStart(64, '0'), sourceOutputIndex: 0, unlockingScript: new Script() });
      source.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: 10_000 });
      const txid = source.id('hex');
      sources.set(txid, source);
      return { txid, vout: 0, satoshis: 10_000, address, privateKey: key };
    });
    const api = { woc: { txHex: async (txid: string) => sources.get(txid)!.toHex() } } as unknown as Api;
    const built = await buildP2pkhTransaction({ api, inputs, outputs: [], changeAddress: recipient, feePerKb: 110 });
    const { minimum, maximum } = signedFeeBounds(built.size, 110);
    expect(built.size).toBeGreaterThan(1000);
    expect(built.fee).toBeGreaterThan(100);
    expect(built.fee).toBeGreaterThan(Math.ceil(built.size * 100 / 1000));
    expect(built.fee).toBeGreaterThanOrEqual(minimum);
    expect(built.fee).toBeLessThanOrEqual(maximum);
  });

  it('refuses a sweep that would leave no positive output', async () => {
    const { api, input } = coin(2);
    await expect(buildP2pkhTransaction({
      api, inputs: [input], outputs: [], changeAddress: recipient, feePerKb: 100,
    })).rejects.toThrow();
  });

  it('does not create a 1-sat sweep output that this tool cannot later spend', async () => {
    const { api, input } = coin(21);
    await expect(buildP2pkhTransaction({
      api, inputs: [input], outputs: [], changeAddress: recipient, feePerKb: 100,
    })).rejects.toThrow(/only 1 sat/);
  });

  it('scales the allowed fee with signed bytes and keeps the chosen target close to 100 sat/kB', () => {
    expect(signedFeeBounds(1200, 100)).toEqual({ minimum: 108, preferred: 120, maximum: 132 });
    expect(signedFeeBounds(1200, 90)).toEqual({ minimum: 108, preferred: 108, maximum: 120 });
    expect(signedFeeBounds(1200, 110)).toEqual({ minimum: 120, preferred: 132, maximum: 132 });
  });

  it('rejects targets outside the rate band and unsafe amounts before signing', async () => {
    const { api, input } = coin(10_000);
    expect(MIN_FEE_PER_KB).toBe(90);
    expect(MAX_FEE_PER_KB).toBe(110);
    expect(sanitizeFee(100_000)).toBe(100);
    expect(sanitizeFee('99junk')).toBe(100);
    expect(sanitizeFee(105)).toBe(105);
    await expect(buildP2pkhTransaction({
      api, inputs: [input], outputs: [], changeAddress: recipient, feePerKb: 111,
    })).rejects.toThrow(/fee target/);
    await expect(buildP2pkhTransaction({
      api, inputs: [input], outputs: [], changeAddress: recipient, feePerKb: 89,
    })).rejects.toThrow(/fee target/);
    await expect(buildP2pkhTransaction({
      api, inputs: [input], outputs: [{ address: recipient, satoshis: Number.MAX_SAFE_INTEGER + 1 }],
      changeAddress: address, feePerKb: 100,
    })).rejects.toThrow(/safe whole sats/);
    await expect(buildP2pkhTransaction({
      api, inputs: [{ ...input, satoshis: 10_000.5 }], outputs: [],
      changeAddress: recipient, feePerKb: 100,
    })).rejects.toThrow(/safe, nonnegative whole numbers/);
    await expect(buildP2pkhTransaction({
      api, inputs: [input, input], outputs: [], changeAddress: recipient, feePerKb: 100,
    })).rejects.toThrow(/selected twice/);
  });
});
