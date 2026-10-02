import {
  Beef, Hash, HD, Mnemonic, P2PKH, PrivateKey, PublicKey, Spend, Transaction, Utils,
  type CreateActionInput, type PositiveIntegerOrZero, type SignActionSpend, type WalletClient,
} from '@bsv/sdk';
import type { Api } from './net';
import { validateMnemonic } from './derive';
import { DEFAULT_SETTINGS, signedFeeBounds } from './settings';
import { buildP2pkhTransaction, type SpendInput } from './tx';

/** BRC-43 self-derivation: invoice number `0-derivation path recovery-YYYY-MM-DD`. */
export const RECOVERY_PROTOCOL: [0, string] = [0, 'derivation path recovery'];
export const RECOVERY_BASKET = 'derivation path recovery';
export type RootScheme = 'BRC-157' | 'BRC-75';

export interface RecoveryReceipt {
  version: 1;
  rootScheme: RootScheme;
  protocolID: [0, string];
  keyID: string;
  counterparty: 'self';
  identityPublicKey: string;
  destinationPublicKey: string;
  address: string;
  satoshis: number;
  fee: number;
  txid: string;
}

export interface PreparedBrc100Sweep {
  receipt: RecoveryReceipt;
  hex: string;
  reference: string;
  spends: Record<PositiveIntegerOrZero, SignActionSpend>;
}

/** A browser download click is not proof that a recovery receipt was saved. */
export function matchesRecoveryReceipt(candidate: unknown, expected: RecoveryReceipt): boolean {
  if (!candidate || typeof candidate !== 'object') return false;
  const got = candidate as Partial<RecoveryReceipt>;
  return got.version === expected.version && got.rootScheme === expected.rootScheme &&
    Array.isArray(got.protocolID) && got.protocolID.length === 2 &&
    got.protocolID[0] === expected.protocolID[0] && got.protocolID[1] === expected.protocolID[1] &&
    got.keyID === expected.keyID && got.counterparty === expected.counterparty &&
    got.identityPublicKey === expected.identityPublicKey &&
    got.destinationPublicKey === expected.destinationPublicKey &&
    got.address === expected.address && got.satoshis === expected.satoshis &&
    got.fee === expected.fee && got.txid === expected.txid;
}

export const WALLET_MISSING = "Couldn't reach your BRC-100 wallet. Open your wallet and try again.";

const SECP256K1_ORDER = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');

/** The bundled SDK validates BIP-39 checksums but does not expose toEntropy(). */
function validateRecoveryEntropy(words: string): void {
  const mnemonic = new Mnemonic(words);
  const wordBits = words.split(' ').map(word => {
    const index = mnemonic.Wordlist.value.indexOf(word);
    if (index < 0) throw new Error('The destination phrase contains an unknown word.');
    return index.toString(2).padStart(11, '0');
  }).join('');
  const entropyBits = wordBits.slice(0, wordBits.length * 32 / 33);
  const scalar = BigInt(`0b${entropyBits}`);
  if (scalar === 0n || scalar >= SECP256K1_ORDER) {
    throw new Error('The destination phrase has invalid BRC-157 entropy. Choose a different backed-up wallet.');
  }
}

export async function requireWallet(wallet: WalletClient) {
  try {
    const { authenticated } = await wallet.isAuthenticated();
    if (!authenticated) throw new Error(WALLET_MISSING);
  } catch {
    throw new Error(WALLET_MISSING);
  }
}

export function recoveryKeyID(day: string): string {
  const timestamp = /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(`${day}T00:00:00.000Z`) : NaN;
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== day) {
    throw new Error('Choose a real UTC date in YYYY-MM-DD form for the recovery key.');
  }
  return day;
}

/** Proves that the connected wallet's receive key is reproducible from its backup. */
export async function verifyRecoveryDestination(
  wallet: WalletClient, mnemonic: string, passphrase: string, day: string,
): Promise<Omit<RecoveryReceipt, 'version' | 'satoshis' | 'fee' | 'txid'>> {
  const keyID = recoveryKeyID(day);
  const words = validateMnemonic(mnemonic);
  const seed = new Mnemonic(words).toSeed(passphrase);
  const identity = (await wallet.getPublicKey({ identityKey: true })).publicKey;
  const root157 = HD.fromSeed(seed).derive("m/0'/0'").privKey as PrivateKey;
  const root75 = new PrivateKey(Hash.sha256(seed));
  const candidates: [RootScheme, PrivateKey][] = [['BRC-157', root157], ['BRC-75', root75]];
  const match = candidates.find(([, key]) => key.toPublicKey().toString() === identity);
  if (!match) {
    throw new Error('The connected wallet identity does not match this backup under BRC-157 or BRC-75. No coins were signed. Check the destination words and passphrase, or use a verified BSV address.');
  }

  const [rootScheme, root] = match;
  if (rootScheme === 'BRC-157') validateRecoveryEntropy(words);
  const invoice = `${RECOVERY_PROTOCOL[0]}-${RECOVERY_PROTOCOL[1]}-${keyID}`;
  const expectedKey = root.deriveChild(root.toPublicKey(), invoice).toPublicKey();
  const walletKey = (await wallet.getPublicKey({
    protocolID: RECOVERY_PROTOCOL, keyID, counterparty: 'self', forSelf: true,
  })).publicKey;
  if (walletKey !== expectedKey.toString()) {
    throw new Error('The wallet returned a recovery key that cannot be derived from your backup. No coins were signed.');
  }
  const destinationPublicKey = PublicKey.fromString(walletKey);
  return {
    rootScheme, protocolID: [...RECOVERY_PROTOCOL], keyID, counterparty: 'self',
    identityPublicKey: identity, destinationPublicKey: walletKey,
    address: destinationPublicKey.toAddress().toString(),
  };
}

function assertAllForkidSignature(tx: Transaction, index: number): void {
  const script = tx.inputs[index].unlockingScript?.toBinary();
  // P2PKH signatures are a direct push of DER bytes followed by sighash 0x41.
  if (!script || script.length < 2 || script[0] < 1 || script[0] > 75 || script[0] >= script.length || script[script[0]] !== 0x41) {
    throw new Error(`Coin ${index + 1} was not signed with SIGHASH_ALL | FORKID, so we stopped.`);
  }
}

/** Creates a reviewable BRC-100 action without broadcasting it. */
export async function prepareBrc100Sweep(params: {
  api: Api;
  wallet: WalletClient;
  inputs: SpendInput[];
  destinationMnemonic: string;
  destinationPassphrase: string;
  day: string;
  onProgress?: (m: string) => void;
}): Promise<PreparedBrc100Sweep> {
  const { api, wallet, inputs, destinationMnemonic, destinationPassphrase, day, onProgress } = params;
  if (!inputs.length) throw new Error('No coins to move.');
  await requireWallet(wallet);
  onProgress?.('Verifying that your destination wallet backup controls the receive key…');
  const destination = await verifyRecoveryDestination(wallet, destinationMnemonic, destinationPassphrase, day);

  // This supplies an exact output amount. The wallet must return only this
  // output and the requested source inputs; it cannot choose hidden change.
  const local = await buildP2pkhTransaction({
    api, inputs, outputs: [], changeAddress: destination.address,
    feePerKb: DEFAULT_SETTINGS.feePerKb, onProgress,
  });
  if (local.tx.outputs.length !== 1 || local.totalOut < 1) throw new Error('No recoverable output could be built.');

  const beef = new Beef();
  const sources = new Map<string, Transaction>();
  for (const txid of new Set(inputs.map(i => i.txid))) {
    onProgress?.(`Getting proof for coin ${txid.slice(0, 16)}…`);
    const beefHex = await api.woc.beefHex(txid);
    beef.mergeBeef(Utils.toArray(beefHex, 'hex'));
    const source = Transaction.fromHexBEEF(beefHex, txid);
    if (source.id('hex') !== txid) throw new Error(`The proof for coin ${txid} does not match its transaction ID.`);
    sources.set(txid, source);
  }

  const inputByOutpoint = new Map<string, SpendInput>();
  const actionInputs: CreateActionInput[] = [];
  for (const input of inputs) {
    const outpoint = `${input.txid}.${input.vout}`;
    if (inputByOutpoint.has(outpoint)) throw new Error(`Coin ${outpoint} was selected twice.`);
    const sourceOutput = sources.get(input.txid)?.outputs[input.vout];
    if (!sourceOutput || sourceOutput.satoshis !== input.satoshis ||
      sourceOutput.lockingScript.toHex() !== new P2PKH().lock(input.address).toHex()) {
      throw new Error(`Coin ${outpoint} is not the verified plain payment we expected.`);
    }
    inputByOutpoint.set(outpoint, input);
    actionInputs.push({ inputDescription: 'Recovered mnemonic coin', unlockingScriptLength: 108, outpoint });
  }

  onProgress?.('Asking your wallet to assemble the exact destination output…');
  const result = await wallet.createAction({
    inputBEEF: beef.toBinary(),
    description: 'Recovering coins to a backed-up BRC-43 wallet key',
    inputs: actionInputs,
    outputs: [{
      lockingScript: new P2PKH().lock(destination.address).toHex(),
      satoshis: local.totalOut,
      outputDescription: 'Backed-up recovery payment',
      basket: RECOVERY_BASKET,
      customInstructions: JSON.stringify({ rootScheme: destination.rootScheme, protocolID: destination.protocolID, keyID: destination.keyID, counterparty: 'self' }),
    }],
    options: { signAndProcess: false, randomizeOutputs: false, acceptDelayedBroadcast: false },
  });
  const signable = result.signableTransaction;
  if (!signable) throw new Error('Your wallet did not return a transaction for review. No source coins were signed.');

  let prepared = false;
  try {
    const tx = Transaction.fromAtomicBEEF(signable.tx);
    if (tx.inputs.length !== inputs.length) throw new Error('The wallet changed the source coin list. No coins were signed.');
    if (tx.outputs.length !== 1 || tx.outputs[0].satoshis !== local.totalOut ||
      tx.outputs[0].lockingScript.toHex() !== new P2PKH().lock(destination.address).toHex()) {
      throw new Error('The wallet changed the recovery output. No coins were signed.');
    }
    const seen = new Set<string>();
    const spends: Record<PositiveIntegerOrZero, SignActionSpend> = {};
    tx.inputs.forEach((txInput) => {
      const source = txInput.sourceTransaction;
      if (!source) throw new Error('The wallet omitted a source transaction. No coins were signed.');
      const txid = source.id('hex');
      const outpoint = `${txid}.${txInput.sourceOutputIndex}`;
      const selected = inputByOutpoint.get(outpoint);
      const sourceOutput = source.outputs[txInput.sourceOutputIndex];
      if (!selected || seen.has(outpoint) || !sourceOutput ||
        sourceOutput.satoshis !== selected.satoshis ||
        sourceOutput.lockingScript.toHex() !== new P2PKH().lock(selected.address).toHex()) {
        throw new Error(`The wallet changed coin ${outpoint}. No coins were signed.`);
      }
      seen.add(outpoint);
      txInput.unlockingScriptTemplate = new P2PKH().unlock(selected.privateKey, 'all', false, selected.satoshis, sourceOutput.lockingScript);
    });
    if (seen.size !== inputByOutpoint.size) throw new Error('The wallet omitted a selected coin. No coins were signed.');

    onProgress?.('Signing and checking every source coin…');
    await tx.sign();
    tx.inputs.forEach((input, index) => {
      assertAllForkidSignature(tx, index);
      const source = input.sourceTransaction!;
      const sourceOutput = source.outputs[input.sourceOutputIndex];
      if (!new Spend({
        sourceTXID: source.id('hex'), sourceOutputIndex: input.sourceOutputIndex,
        sourceSatoshis: sourceOutput.satoshis!, lockingScript: sourceOutput.lockingScript,
        transactionVersion: tx.version, otherInputs: tx.inputs.filter((_, i) => i !== index),
        outputs: tx.outputs, inputIndex: index, unlockingScript: input.unlockingScript!,
        inputSequence: input.sequence ?? 0xffffffff, lockTime: tx.lockTime,
      }).validate()) throw new Error(`Coin ${index + 1} failed signature verification.`);
      spends[index] = { unlockingScript: input.unlockingScript!.toHex() };
    });

    const hex = tx.toHex();
    const fee = local.totalIn - local.totalOut;
    const { minimum, maximum } = signedFeeBounds(hex.length / 2, DEFAULT_SETTINGS.feePerKb);
    if (!Number.isSafeInteger(fee) || fee < minimum || fee > maximum) {
      throw new Error(`The final ${fee}-sat fee is outside the ${minimum}–${maximum}-sat tolerance for this signed transaction.`);
    }
    const receipt: RecoveryReceipt = {
      version: 1, ...destination, satoshis: local.totalOut, fee, txid: tx.id('hex'),
    };
    prepared = true;
    return { receipt, hex, reference: signable.reference, spends };
  } finally {
    if (!prepared) {
      try { await wallet.abortAction({ reference: signable.reference }); } catch { /* Action will expire at the wallet. */ }
    }
  }
}

/** Broadcasts only a previously reviewed action bound by ALL|FORKID signatures. */
export async function sendPreparedBrc100Sweep(wallet: WalletClient, prepared: PreparedBrc100Sweep): Promise<{ txid: string; hex: string }> {
  await requireWallet(wallet);
  const identity = (await wallet.getPublicKey({ identityKey: true })).publicKey;
  if (identity !== prepared.receipt.identityPublicKey) throw new Error('The connected wallet changed since this transaction was prepared.');
  let result;
  try {
    result = await wallet.signAction({
      reference: prepared.reference, spends: prepared.spends,
      options: { acceptDelayedBroadcast: false, returnTXIDOnly: true },
    });
  } catch (error) {
    throw new Error(`Broadcast status is uncertain. Check transaction ${prepared.receipt.txid} before retrying: ${(error as Error).message}`);
  }
  if (result.txid !== prepared.receipt.txid) {
    throw new Error(`The wallet did not confirm the prepared transaction ID. Check ${prepared.receipt.txid} before trying again.`);
  }
  return { txid: result.txid, hex: prepared.hex };
}
