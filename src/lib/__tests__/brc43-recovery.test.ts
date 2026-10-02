import { describe, expect, it, vi } from 'vitest';
import { P2PKH, PrivateKey, Script, Spend, Transaction } from '@bsv/sdk';
import {
  deriveDatedRecoveryKey, parseDatedRecoveryReceipt,
  prepareDatedRecoverySweep, scanDatedRecoveryOutput,
} from '../brc43-recovery';
import { RECOVERY_PROTOCOL, type RootScheme } from '../brc100';
import type { Api, OrdinalTxo } from '../net';
import { signedFeeBounds } from '../settings';

const MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const DAY = '2026-09-30';

function key(scheme: RootScheme = 'BRC-157') {
  return deriveDatedRecoveryKey({ mnemonic: MNEMONIC, passphrase: '', rootScheme: scheme, day: DAY });
}

describe('wallet-independent dated BRC-43 recovery', () => {
  it.each(['BRC-157', 'BRC-75'] as const)('reproduces the %s receipt key without a wallet connection', scheme => {
    const derived = key(scheme);
    const receipt = parseDatedRecoveryReceipt(JSON.stringify({
      version: 1, rootScheme: scheme, protocolID: RECOVERY_PROTOCOL, keyID: DAY,
      counterparty: 'self', identityPublicKey: derived.identityPublicKey,
      destinationPublicKey: derived.destinationPublicKey, address: derived.address,
      satoshis: 999, fee: 1, txid: 'ab'.repeat(32),
    }));
    expect(receipt.address).toBe(derived.privateKey.toAddress().toString());
    expect(deriveDatedRecoveryKey({ mnemonic: MNEMONIC, passphrase: '', rootScheme: scheme, day: DAY, expectedAddress: receipt.address }).destinationPublicKey)
      .toBe(receipt.destinationPublicKey);
    expect(() => deriveDatedRecoveryKey({ mnemonic: MNEMONIC, passphrase: 'wrong', rootScheme: scheme, day: DAY, expectedAddress: receipt.address }))
      .toThrow(/does not match the receipt address/);
  });

  it('rejects altered receipt metadata and invalid BRC-157 entropy, while BRC-75 accepts that BIP-39 phrase', () => {
    const derived = key();
    const receipt = {
      version: 1, rootScheme: 'BRC-157', protocolID: RECOVERY_PROTOCOL,
      keyID: DAY, counterparty: 'self', identityPublicKey: derived.identityPublicKey,
      destinationPublicKey: derived.destinationPublicKey, address: derived.address,
      satoshis: 10, fee: 1, txid: 'ab'.repeat(32),
    };
    expect(() => parseDatedRecoveryReceipt(JSON.stringify({ ...receipt, protocolID: [0, 'other'] }))).toThrow(/not a receipt/);
    expect(() => parseDatedRecoveryReceipt(JSON.stringify({ ...receipt, address: PrivateKey.fromHex('11'.repeat(32)).toAddress().toString() })))
      .toThrow(/does not match/);
    const zero = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    expect(() => deriveDatedRecoveryKey({ mnemonic: zero, passphrase: '', rootScheme: 'BRC-157', day: DAY })).toThrow(/invalid BRC-157 entropy/);
    expect(() => deriveDatedRecoveryKey({ mnemonic: zero, passphrase: '', rootScheme: 'BRC-75', day: DAY })).not.toThrow();
  });

  it('only returns plain coins and fails closed if the token indexer fails', async () => {
    const derived = key();
    const unspent = vi.fn(async () => [
      { tx_hash: 'aa'.repeat(32), tx_pos: 0, value: 10_000 },
      { tx_hash: 'bb'.repeat(32), tx_pos: 1, value: 2_000 },
      { tx_hash: 'cc'.repeat(32), tx_pos: 2, value: 1 },
    ]);
    const protectedCoins = vi.fn(async () => [{ txid: 'bb'.repeat(32), vout: 1, satoshis: 2_000, origin: { num: '123' } }]);
    const api = { woc: { unspent }, ordinals: { unspent: protectedCoins } } as unknown as Api;
    const scan = await scanDatedRecoveryOutput(api, derived);
    expect(scan.utxos).toEqual([{ txid: 'aa'.repeat(32), vout: 0, satoshis: 10_000 }]);
    expect(scan.protectedCount).toBe(2);
    protectedCoins.mockRejectedValueOnce(new Error('overlay unavailable'));
    await expect(scanDatedRecoveryOutput(api, derived)).rejects.toThrow(/nothing was sent/);
  });

  it('re-derives the scanned key, rechecks protection, then signs only the chosen backed-up address with a bounded fee', async () => {
    const derived = key();
    const source = new Transaction();
    source.addInput({ sourceTXID: '00'.repeat(32), sourceOutputIndex: 0, unlockingScript: new Script() });
    source.addOutput({ lockingScript: new P2PKH().lock(derived.address), satoshis: 100_000 });
    const txid = source.id('hex');
    const unspent = vi.fn(async () => [{ tx_hash: txid, tx_pos: 0, value: 100_000 }]);
    const protectedCoins = vi.fn(async (): Promise<OrdinalTxo[]> => []);
    const api = { woc: { unspent, txHex: vi.fn(async () => source.toHex()) }, ordinals: { unspent: protectedCoins } } as unknown as Api;
    const scan = await scanDatedRecoveryOutput(api, derived);
    const destination = PrivateKey.fromHex('22'.repeat(32)).toAddress().toString();

    await expect(prepareDatedRecoverySweep({ api, scan, mnemonic: MNEMONIC, passphrase: 'wrong', destinationAddress: destination, feePerKb: 100 }))
      .rejects.toThrow(/does not match the receipt address/);
    protectedCoins.mockResolvedValueOnce([{ txid, vout: 0, satoshis: 100_000, origin: { num: '7' } }]);
    await expect(prepareDatedRecoverySweep({ api, scan, mnemonic: MNEMONIC, passphrase: '', destinationAddress: destination, feePerKb: 100 }))
      .rejects.toThrow(/now protected/);

    unspent.mockResolvedValueOnce([{ tx_hash: 'ff'.repeat(32), tx_pos: 0, value: 100_000 }]);
    await expect(prepareDatedRecoverySweep({ api, scan, mnemonic: MNEMONIC, passphrase: '', destinationAddress: destination, feePerKb: 100 }))
      .rejects.toThrow(/coin list changed/);

    const built = await prepareDatedRecoverySweep({ api, scan, mnemonic: MNEMONIC, passphrase: '', destinationAddress: destination, feePerKb: 100 });
    expect(built.tx.outputs).toHaveLength(1);
    expect(built.tx.outputs[0].lockingScript.toHex()).toBe(new P2PKH().lock(destination).toHex());
    const { minimum, maximum } = signedFeeBounds(built.size, 100);
    expect(built.fee).toBeGreaterThanOrEqual(minimum);
    expect(built.fee).toBeLessThanOrEqual(maximum);
    const input = built.tx.inputs[0];
    expect(input.unlockingScript?.chunks[0]?.data?.at(-1)).toBe(0x41);
    expect(new Spend({
      sourceTXID: txid, sourceOutputIndex: 0, sourceSatoshis: 100_000,
      lockingScript: source.outputs[0].lockingScript,
      transactionVersion: built.tx.version, otherInputs: [], outputs: built.tx.outputs,
      inputIndex: 0, unlockingScript: input.unlockingScript!,
      inputSequence: input.sequence ?? 0xffffffff, lockTime: built.tx.lockTime,
    }).validate()).toBe(true);
  });
});
