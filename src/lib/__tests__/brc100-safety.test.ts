import { describe, expect, it, vi } from 'vitest';
import { Hash, HD, MerklePath, Mnemonic, P2PKH, PrivateKey, Script, Spend, Transaction, UnlockingScript, Utils, type WalletClient } from '@bsv/sdk';
import {
  matchesRecoveryReceipt, prepareBrc100Sweep, RECOVERY_BASKET, RECOVERY_PROTOCOL, recoveryKeyID,
  sendPreparedBrc100Sweep, verifyRecoveryDestination, type RootScheme,
} from '../brc100';
import type { Api } from '../net';
import { signedFeeBounds } from '../settings';

const MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const PASSPHRASE = 'destination backup passphrase';
const DAY = '2026-09-30';

type WalletResponse = 'honest' | 'wrong-address' | 'extra-input' | 'zero-output' | 'high-fee';

function fixture(scheme: RootScheme = 'BRC-157', response: WalletResponse = 'honest') {
  const seed = new Mnemonic(MNEMONIC).toSeed(PASSPHRASE);
  const identityKey = scheme === 'BRC-157'
    ? HD.fromSeed(seed).derive("m/0'/0'").privKey as PrivateKey
    : new PrivateKey(Hash.sha256(seed));
  const identityPublicKey = identityKey.toPublicKey().toString();
  const invoice = `0-${RECOVERY_PROTOCOL[1]}-${DAY}`;
  const destinationPublicKey = identityKey.deriveChild(identityKey.toPublicKey(), invoice).toPublicKey().toString();
  const destinationAddress = identityKey.deriveChild(identityKey.toPublicKey(), invoice).toAddress().toString();
  const sourceKey = PrivateKey.fromHex('11'.repeat(32));
  const sourceAddress = sourceKey.toAddress().toString();
  const wrongAddress = PrivateKey.fromHex('22'.repeat(32)).toAddress().toString();

  const source = new Transaction();
  source.addInput({ sourceTXID: '00'.repeat(32), sourceOutputIndex: 0, unlockingScript: new Script() });
  source.addOutput({ lockingScript: new P2PKH().lock(sourceAddress), satoshis: 100_000 });
  const sourceTxid = source.id('hex');
  source.merklePath = MerklePath.fromCoinbaseTxidAndHeight(sourceTxid, 1);
  const input = { txid: sourceTxid, vout: 0, satoshis: 100_000, address: sourceAddress, privateKey: sourceKey };
  const api = { woc: {
    txHex: async () => source.toHex(),
    beefHex: async () => source.toHexBEEF(),
  } } as unknown as Api;

  const getPublicKey = vi.fn(async (args: { identityKey?: boolean; keyID?: string }) => ({
    publicKey: args.identityKey ? identityPublicKey : destinationPublicKey,
  }));
  const createAction = vi.fn(async (args: Parameters<WalletClient['createAction']>[0]) => {
    const tx = new Transaction();
    tx.addInput({ sourceTransaction: source, sourceOutputIndex: 0, unlockingScript: new UnlockingScript() });
    if (response === 'extra-input') tx.addInput({ sourceTransaction: source, sourceOutputIndex: 0, unlockingScript: new UnlockingScript() });
    if (response !== 'zero-output') {
      const requested = args.outputs![0].satoshis;
      tx.addOutput({
        lockingScript: new P2PKH().lock(response === 'wrong-address' ? wrongAddress : destinationAddress),
        satoshis: response === 'high-fee' ? requested - 1000 : requested,
      });
    }
    return { signableTransaction: { tx: tx.toAtomicBEEF(), reference: 'fixture-reference' } };
  });
  const abortAction = vi.fn(async () => ({ aborted: true }));
  const signAction = vi.fn(async () => ({ txid: '' }));
  const wallet = {
    isAuthenticated: vi.fn(async () => ({ authenticated: true })),
    getPublicKey, createAction, abortAction, signAction,
  } as unknown as WalletClient;
  const params = {
    api, wallet, inputs: [input], destinationMnemonic: MNEMONIC,
    destinationPassphrase: PASSPHRASE, day: DAY,
  };
  return { wallet, params, input, source, destinationAddress, destinationPublicKey,
    identityPublicKey, getPublicKey, createAction, abortAction, signAction };
}

describe('BRC-100 recovery transaction safety', () => {
  it('matches the published BRC-75 mnemonic-to-identity vector', async () => {
    // https://bsv.brc.dev/key-derivation/0075
    const words = 'dial tunnel valid cry exhaust stand match purse hope since demand palace';
    const publishedRoot = PrivateKey.fromHex('1ad0895dd317163f0e83499c30bc593dbcc54cad96a5f57b065ce9f700513250');
    const publishedIdentity = '021c2361fa1c39e21422b1374c2a08106f99b5425ada71f46f55b8e8e9d4a932db';
    expect(Utils.toHex(Hash.sha256(new Mnemonic(words).toSeed('')))).toBe(Utils.toHex(publishedRoot.toArray('be', 32)));
    expect(publishedRoot.toPublicKey().toString()).toBe(publishedIdentity);
    const child = publishedRoot.deriveChild(publishedRoot.toPublicKey(), `0-${RECOVERY_PROTOCOL[1]}-${DAY}`).toPublicKey().toString();
    const wallet = { getPublicKey: vi.fn(async (args: { identityKey?: boolean }) => ({ publicKey: args.identityKey ? publishedIdentity : child })) } as unknown as WalletClient;
    const result = await verifyRecoveryDestination(wallet, words, '', DAY);
    expect(result.rootScheme).toBe('BRC-75');
    expect(result.identityPublicKey).toBe(publishedIdentity);
  });

  it('matches the published BRC-157 mnemonic-to-root vector', async () => {
    // https://bsv.brc.dev/key-derivation/0157
    const words = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
    const publishedRoot = PrivateKey.fromHex('27e442c8015fc055789d6628f3b30461e8b2598aff74dc87ceef00dd8e670e55');
    const derivedRoot = HD.fromSeed(new Mnemonic(words).toSeed('')).derive("m/0'/0'").privKey as PrivateKey;
    expect(Utils.toHex(derivedRoot.toArray('be', 32))).toBe(Utils.toHex(publishedRoot.toArray('be', 32)));
    const publishedIdentity = publishedRoot.toPublicKey().toString();
    const child = publishedRoot.deriveChild(publishedRoot.toPublicKey(), `0-${RECOVERY_PROTOCOL[1]}-${DAY}`).toPublicKey().toString();
    const wallet = { getPublicKey: vi.fn(async (args: { identityKey?: boolean }) => ({ publicKey: args.identityKey ? publishedIdentity : child })) } as unknown as WalletClient;
    const result = await verifyRecoveryDestination(wallet, words, '', DAY);
    expect(result.rootScheme).toBe('BRC-157');
    expect(result.identityPublicKey).toBe(publishedIdentity);
  });

  it.each(['BRC-157', 'BRC-75'] as const)('matches a %s backup and derives the disclosed recovery output', async scheme => {
    const f = fixture(scheme);
    const destination = await verifyRecoveryDestination(f.wallet, MNEMONIC, PASSPHRASE, DAY);
    expect(destination).toMatchObject({
      rootScheme: scheme, protocolID: RECOVERY_PROTOCOL, keyID: DAY, counterparty: 'self',
      identityPublicKey: f.identityPublicKey, destinationPublicKey: f.destinationPublicKey,
      address: f.destinationAddress,
    });

    const prepared = await prepareBrc100Sweep(f.params);
    expect(prepared.receipt).toMatchObject({
      rootScheme: scheme, protocolID: RECOVERY_PROTOCOL, keyID: DAY,
      address: f.destinationAddress, identityPublicKey: f.identityPublicKey,
    });
    const request = f.createAction.mock.calls[0][0];
    expect(request.inputs).toHaveLength(1);
    expect(request.outputs).toHaveLength(1);
    expect(request.outputs![0]).toMatchObject({
      lockingScript: new P2PKH().lock(f.destinationAddress).toHex(),
      satoshis: prepared.receipt.satoshis, basket: RECOVERY_BASKET,
    });
    expect(JSON.parse(request.outputs![0].customInstructions!)).toMatchObject({
      rootScheme: scheme, protocolID: RECOVERY_PROTOCOL, keyID: DAY, counterparty: 'self',
    });
    expect(prepared.receipt.fee).toBeGreaterThan(0);
    const { minimum, maximum } = signedFeeBounds(prepared.hex.length / 2, 100);
    expect(prepared.receipt.fee).toBeGreaterThanOrEqual(minimum);
    expect(prepared.receipt.fee).toBeLessThanOrEqual(maximum);
    expect(matchesRecoveryReceipt(JSON.parse(JSON.stringify(prepared.receipt)), prepared.receipt)).toBe(true);
    expect(matchesRecoveryReceipt({ ...prepared.receipt, keyID: '2026-09-29' }, prepared.receipt)).toBe(false);
    expect(f.abortAction).not.toHaveBeenCalled();
    expect(f.signAction).not.toHaveBeenCalled();

    const signed = Transaction.fromHex(prepared.hex);
    expect(signed.outputs).toHaveLength(1);
    expect(signed.outputs[0].lockingScript.toHex()).toBe(new P2PKH().lock(f.destinationAddress).toHex());
    const script = signed.inputs[0].unlockingScript!.toBinary();
    expect(script[script[0]]).toBe(0x41); // SIGHASH_ALL | FORKID, without ANYONECANPAY
    const sourceOutput = f.source.outputs[0];
    const spend = (outputs: Transaction['outputs']) => new Spend({
      sourceTXID: f.input.txid, sourceOutputIndex: 0,
      sourceSatoshis: sourceOutput.satoshis!, lockingScript: sourceOutput.lockingScript,
      transactionVersion: signed.version, otherInputs: [], outputs, inputIndex: 0,
      unlockingScript: signed.inputs[0].unlockingScript!,
      inputSequence: signed.inputs[0].sequence ?? 0xffffffff, lockTime: signed.lockTime,
    });
    expect(spend(signed.outputs).validate()).toBe(true);
    const redirected = signed.outputs.map(o => ({ ...o }));
    redirected[0].lockingScript = new P2PKH().lock(PrivateKey.fromHex('33'.repeat(32)).toAddress().toString());
    let validAfterRedirection = false;
    try { validAfterRedirection = spend(redirected).validate(); } catch { /* Invalid signature can throw. */ }
    expect(validAfterRedirection).toBe(false);
  });

  it('rejects impossible dates before asking the wallet for an output', async () => {
    expect(() => recoveryKeyID('2026-02-30')).toThrow(/real UTC date/);
    expect(() => recoveryKeyID('2026-9-30')).toThrow(/real UTC date/);
    const f = fixture();
    await expect(prepareBrc100Sweep({ ...f.params, day: '2026-02-30' })).rejects.toThrow(/real UTC date/);
    expect(f.getPublicKey).not.toHaveBeenCalled();
    expect(f.createAction).not.toHaveBeenCalled();
  });

  it('signs multiple source addresses with their own keys and one fixed destination', async () => {
    const f = fixture();
    const otherKey = PrivateKey.fromHex('44'.repeat(32));
    const otherAddress = otherKey.toAddress().toString();
    const otherSource = new Transaction();
    otherSource.addInput({ sourceTXID: '00'.repeat(32), sourceOutputIndex: 0, unlockingScript: new Script() });
    otherSource.addOutput({ lockingScript: new P2PKH().lock(otherAddress), satoshis: 50_000 });
    const otherTxid = otherSource.id('hex');
    otherSource.merklePath = MerklePath.fromCoinbaseTxidAndHeight(otherTxid, 1);
    f.params.inputs.push({ txid: otherTxid, vout: 0, satoshis: 50_000, address: otherAddress, privateKey: otherKey });
    f.params.api.woc.txHex = async txid => (txid === otherTxid ? otherSource : f.source).toHex();
    f.params.api.woc.beefHex = async txid => (txid === otherTxid ? otherSource : f.source).toHexBEEF();
    f.createAction.mockImplementation(async args => {
      const tx = new Transaction();
      tx.addInput({ sourceTransaction: f.source, sourceOutputIndex: 0, unlockingScript: new UnlockingScript() });
      tx.addInput({ sourceTransaction: otherSource, sourceOutputIndex: 0, unlockingScript: new UnlockingScript() });
      tx.addOutput({ lockingScript: new P2PKH().lock(f.destinationAddress), satoshis: args.outputs![0].satoshis });
      return { signableTransaction: { tx: tx.toAtomicBEEF(), reference: 'two-inputs' } };
    });
    const prepared = await prepareBrc100Sweep(f.params);
    expect(Transaction.fromHex(prepared.hex).inputs).toHaveLength(2);
    expect(Object.keys(prepared.spends)).toEqual(['0', '1']);
    expect(prepared.receipt.address).toBe(f.destinationAddress);
    const { minimum, maximum } = signedFeeBounds(prepared.hex.length / 2, 100);
    expect(prepared.receipt.fee).toBeGreaterThanOrEqual(minimum);
    expect(prepared.receipt.fee).toBeLessThanOrEqual(maximum);
  });

  it('rejects invalid BRC-157 entropy while preserving valid BRC-75 compatibility', async () => {
    const zero = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const aboveOrder = Mnemonic.fromEntropy(Array(32).fill(255)).toString();
    for (const words of [zero, aboveOrder]) {
      const seed = new Mnemonic(words).toSeed('');
      const root157 = HD.fromSeed(seed).derive("m/0'/0'").privKey as PrivateKey;
      const root75 = new PrivateKey(Hash.sha256(seed));
      const child = root75.deriveChild(root75.toPublicKey(), `0-${RECOVERY_PROTOCOL[1]}-${DAY}`).toPublicKey().toString();
      const identity = vi.fn(async () => ({ publicKey: root157.toPublicKey().toString() }));
      await expect(verifyRecoveryDestination({ getPublicKey: identity } as unknown as WalletClient, words, '', DAY))
        .rejects.toThrow(/invalid BRC-157 entropy/);
      const wallet75 = { getPublicKey: vi.fn(async (args: { identityKey?: boolean }) => ({
        publicKey: args.identityKey ? root75.toPublicKey().toString() : child,
      })) } as unknown as WalletClient;
      expect((await verifyRecoveryDestination(wallet75, words, '', DAY)).rootScheme).toBe('BRC-75');
    }
  });

  it('refuses a wallet identity or derived key that does not match the destination backup', async () => {
    const wrongIdentity = fixture();
    wrongIdentity.getPublicKey.mockResolvedValueOnce({ publicKey: PrivateKey.fromRandom().toPublicKey().toString() });
    await expect(verifyRecoveryDestination(wrongIdentity.wallet, MNEMONIC, PASSPHRASE, DAY)).rejects.toThrow(/does not match this backup/);
    expect(wrongIdentity.createAction).not.toHaveBeenCalled();

    const wrongChild = fixture();
    wrongChild.getPublicKey.mockResolvedValueOnce({ publicKey: wrongChild.identityPublicKey });
    wrongChild.getPublicKey.mockResolvedValueOnce({ publicKey: PrivateKey.fromRandom().toPublicKey().toString() });
    await expect(verifyRecoveryDestination(wrongChild.wallet, MNEMONIC, PASSPHRASE, DAY)).rejects.toThrow(/cannot be derived/);
    expect(wrongChild.createAction).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong-address', /changed the recovery output/],
    ['extra-input', /changed the source coin list/],
    ['zero-output', /changed the recovery output/],
    ['high-fee', /changed the recovery output/],
  ] as const)('refuses a wallet response with %s before returning any signatures', async (response, error) => {
    const f = fixture('BRC-157', response);
    await expect(prepareBrc100Sweep(f.params)).rejects.toThrow(error);
    expect(f.abortAction).toHaveBeenCalledWith({ reference: 'fixture-reference' });
    expect(f.signAction).not.toHaveBeenCalled();
  });

  it('does not accept a different wallet or transaction ID at broadcast', async () => {
    const f = fixture();
    const prepared = await prepareBrc100Sweep(f.params);
    f.getPublicKey.mockResolvedValueOnce({ publicKey: PrivateKey.fromRandom().toPublicKey().toString() });
    await expect(sendPreparedBrc100Sweep(f.wallet, prepared)).rejects.toThrow(/connected wallet changed/);
    expect(f.signAction).not.toHaveBeenCalled();

    f.signAction.mockResolvedValueOnce({ txid: 'ff'.repeat(32) });
    await expect(sendPreparedBrc100Sweep(f.wallet, prepared)).rejects.toThrow(/did not confirm the prepared transaction ID/);
  });
});
