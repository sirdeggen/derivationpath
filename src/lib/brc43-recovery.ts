import { Hash, HD, Mnemonic, PrivateKey, PublicKey } from '@bsv/sdk';
import type { Api } from './net';
import { validateMnemonic, isValidAddress } from './derive';
import { RECOVERY_PROTOCOL, recoveryKeyID, type RecoveryReceipt, type RootScheme } from './brc100';
import { filterSpendable, outpointKey, protectedSet } from './tokens';
import { buildP2pkhTransaction, type BuiltTx, type SpendInput } from './tx';

const SECP256K1_ORDER = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');

export interface DatedRecoveryKey {
  rootScheme: RootScheme;
  keyID: string;
  identityPublicKey: string;
  destinationPublicKey: string;
  address: string;
  privateKey: PrivateKey;
}

export interface DatedRecoveryScan {
  rootScheme: RootScheme;
  keyID: string;
  identityPublicKey: string;
  destinationPublicKey: string;
  address: string;
  /** Public coin details only. The phrase and private key are discarded after each operation. */
  utxos: { txid: string; vout: number; satoshis: number }[];
  protectedCount: number;
}

/** Rejects a receipt with altered derivation metadata before it can guide a scan. */
export function parseDatedRecoveryReceipt(json: string): RecoveryReceipt {
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new Error('The recovery receipt is not valid JSON.'); }
  if (!value || typeof value !== 'object') throw new Error('The recovery receipt is not an object.');
  const receipt = value as Partial<RecoveryReceipt>;
  if (receipt.version !== 1 || (receipt.rootScheme !== 'BRC-157' && receipt.rootScheme !== 'BRC-75') ||
    !Array.isArray(receipt.protocolID) || receipt.protocolID[0] !== RECOVERY_PROTOCOL[0] || receipt.protocolID[1] !== RECOVERY_PROTOCOL[1] ||
    receipt.counterparty !== 'self' || typeof receipt.keyID !== 'string' || typeof receipt.address !== 'string' ||
    typeof receipt.identityPublicKey !== 'string' || typeof receipt.destinationPublicKey !== 'string' ||
    typeof receipt.txid !== 'string' || !/^[0-9a-f]{64}$/i.test(receipt.txid) ||
    !Number.isSafeInteger(receipt.satoshis) || (receipt.satoshis ?? 0) < 1 ||
    !Number.isSafeInteger(receipt.fee) || (receipt.fee ?? 0) < 1) {
    throw new Error('This is not a receipt for this app’s dated BRC-43 recovery key.');
  }
  recoveryKeyID(receipt.keyID);
  try {
    PublicKey.fromString(receipt.identityPublicKey);
    const address = PublicKey.fromString(receipt.destinationPublicKey).toAddress().toString();
    if (address !== receipt.address || !isValidAddress(receipt.address)) throw new Error('mismatch');
  } catch {
    throw new Error('The receipt public key does not match its destination address.');
  }
  return receipt as RecoveryReceipt;
}

/** BRC-157 treats the mnemonic's entropy as a secp256k1 scalar. BRC-75 does not. */
function assertBrc157Entropy(words: string): void {
  const mnemonic = new Mnemonic(words);
  const bits = words.split(' ').map(word => {
    const index = mnemonic.Wordlist.value.indexOf(word);
    if (index < 0) throw new Error('The recovery phrase contains an unknown word.');
    return index.toString(2).padStart(11, '0');
  }).join('');
  const scalar = BigInt(`0b${bits.slice(0, bits.length * 32 / 33)}`);
  if (scalar === 0n || scalar >= SECP256K1_ORDER) {
    throw new Error('This phrase has invalid BRC-157 entropy. Check the receipt root scheme.');
  }
}

/** Derives the app's disclosed self-counterparty BRC-43 key without a wallet SDK. */
export function deriveDatedRecoveryKey(params: {
  mnemonic: string;
  passphrase: string;
  rootScheme: RootScheme;
  day: string;
  expectedAddress?: string;
}): DatedRecoveryKey {
  const { passphrase, rootScheme, expectedAddress } = params;
  const keyID = recoveryKeyID(params.day);
  const words = validateMnemonic(params.mnemonic);
  if (rootScheme !== 'BRC-157' && rootScheme !== 'BRC-75') throw new Error('Choose a supported root scheme from the receipt.');
  if (rootScheme === 'BRC-157') assertBrc157Entropy(words);
  const seed = new Mnemonic(words).toSeed(passphrase);
  const root = rootScheme === 'BRC-157'
    ? HD.fromSeed(seed).derive("m/0'/0'").privKey as PrivateKey
    : new PrivateKey(Hash.sha256(seed));
  const invoice = `${RECOVERY_PROTOCOL[0]}-${RECOVERY_PROTOCOL[1]}-${keyID}`;
  const privateKey = root.deriveChild(root.toPublicKey(), invoice);
  const destinationPublicKey = privateKey.toPublicKey().toString();
  const address = PublicKey.fromString(destinationPublicKey).toAddress().toString();
  if (expectedAddress?.trim() && (!isValidAddress(expectedAddress.trim()) || address !== expectedAddress.trim())) {
    throw new Error('The derived address does not match the receipt address. Check the phrase, passphrase, root scheme and date.');
  }
  return { rootScheme, keyID, identityPublicKey: root.toPublicKey().toString(), destinationPublicKey, address, privateKey };
}

/** A single-address scan. Indexer failure rejects the whole result. */
export async function scanDatedRecoveryOutput(api: Api, key: DatedRecoveryKey, signal?: AbortSignal): Promise<DatedRecoveryScan> {
  if (signal?.aborted) throw new Error('Recovery scan stopped.');
  const raw = await api.woc.unspent(key.address);
  if (signal?.aborted) throw new Error('Recovery scan stopped.');
  const protectedOutpoints = raw.length ? await protectedSet(api, key.address) : new Set<string>();
  if (signal?.aborted) throw new Error('Recovery scan stopped.');
  const { spendable, protectedCount } = filterSpendable(
    raw.map(u => ({ txid: u.tx_hash, vout: u.tx_pos, satoshis: u.value })),
    protectedOutpoints,
  );
  return {
    rootScheme: key.rootScheme, keyID: key.keyID,
    identityPublicKey: key.identityPublicKey, destinationPublicKey: key.destinationPublicKey,
    address: key.address, utxos: spendable, protectedCount,
  };
}

/** Re-derives the key immediately before signing and rechecks token protection. */
export async function prepareDatedRecoverySweep(params: {
  api: Api;
  scan: DatedRecoveryScan;
  mnemonic: string;
  passphrase: string;
  destinationAddress: string;
  feePerKb: number;
  onProgress?: (m: string) => void;
}): Promise<BuiltTx> {
  const { api, scan, destinationAddress, feePerKb, onProgress } = params;
  if (!scan.utxos.length) throw new Error('There are no plain BSV coins to move at this recovery address.');
  const key = deriveDatedRecoveryKey({
    mnemonic: params.mnemonic, passphrase: params.passphrase,
    rootScheme: scan.rootScheme, day: scan.keyID, expectedAddress: scan.address,
  });
  if (key.identityPublicKey !== scan.identityPublicKey || key.destinationPublicKey !== scan.destinationPublicKey) {
    throw new Error('The re-entered backup does not match the scanned recovery key.');
  }
  onProgress?.('Rechecking coins, NFTs and tokens before signing…');
  const latest = await api.woc.unspent(key.address);
  const protectedOutpoints = await protectedSet(api, key.address);
  const latestSpendable = filterSpendable(
    latest.map(u => ({ txid: u.tx_hash, vout: u.tx_pos, satoshis: u.value })), protectedOutpoints,
  ).spendable;
  for (const coin of scan.utxos) {
    if (coin.satoshis <= 1 || protectedOutpoints.has(outpointKey(coin.txid, coin.vout))) {
      throw new Error(`Coin ${coin.txid}:${coin.vout} is now protected. Scan again before moving funds.`);
    }
  }
  const expected = new Map(scan.utxos.map(coin => [outpointKey(coin.txid, coin.vout), coin.satoshis]));
  const latestKeys = new Set(latestSpendable.map(coin => outpointKey(coin.txid, coin.vout)));
  if (expected.size !== scan.utxos.length || latestSpendable.length !== scan.utxos.length ||
    latestKeys.size !== scan.utxos.length ||
    latestSpendable.some(coin => expected.get(outpointKey(coin.txid, coin.vout)) !== coin.satoshis)) {
    throw new Error('The plain coin list changed since the scan. Scan again before moving funds.');
  }
  const inputs: SpendInput[] = scan.utxos.map(u => ({ ...u, address: key.address, privateKey: key.privateKey }));
  return buildP2pkhTransaction({
    api, inputs, outputs: [], changeAddress: destinationAddress, feePerKb, onProgress,
  });
}
