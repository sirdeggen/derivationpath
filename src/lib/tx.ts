import { P2PKH, SatoshisPerKilobyte, Spend, Transaction, type PrivateKey } from '@bsv/sdk';
import type { Api } from './net';
import { isValidAddress } from './derive';
import { MAX_FEE_PER_KB, MIN_FEE_PER_KB, signedFeeBounds } from './settings';

export interface SpendInput {
  txid: string;
  vout: number;
  satoshis: number;
  address: string;
  privateKey: PrivateKey;
}

export interface BuiltTx {
  tx: Transaction;
  hex: string;
  txid: string;
  totalIn: number;
  totalOut: number;
  fee: number;
  size: number;
}

/**
 * Fetches each source transaction and checks it really pays the claimed
 * amount to the claimed address. Signing commits to the source amount, so an
 * API that lied about a UTXO's value could otherwise trick us into burning fee.
 */
async function loadSources(api: Api, inputs: SpendInput[], onProgress?: (m: string) => void) {
  const sources = new Map<string, Transaction>();
  for (const txid of new Set(inputs.map(i => i.txid))) {
    onProgress?.(`Checking coin ${txid.slice(0, 16)}…`);
    const tx = Transaction.fromHex(await api.woc.txHex(txid));
    if (tx.id('hex') !== txid) throw new Error(`The data for transaction ${txid} didn't check out, so we stopped to keep you safe.`);
    sources.set(txid, tx);
  }
  for (const input of inputs) {
    const out = sources.get(input.txid)!.outputs[input.vout];
    const expected = new P2PKH().lock(input.address).toHex();
    if (!out) throw new Error(`Coin ${input.txid}:${input.vout} doesn't exist.`);
    if (out.satoshis !== input.satoshis) throw new Error(`Coin ${input.txid}:${input.vout} holds ${out.satoshis} sats, not the ${input.satoshis} we were told, so we stopped to keep you safe.`);
    if (out.lockingScript.toHex() !== expected) throw new Error(`Coin ${input.txid}:${input.vout} isn't a plain payment to ${input.address} (it may hold an NFT), so we won't spend it.`);
  }
  return sources;
}

/**
 * Builds and signs a P2PKH transaction. `outputs` are fixed payments; all
 * remaining value (minus fee) goes to `changeAddress`. For a sweep, pass no
 * outputs and the destination as `changeAddress`.
 */
export async function buildP2pkhTransaction(params: {
  api: Api;
  inputs: SpendInput[];
  outputs: { address: string; satoshis: number }[];
  changeAddress: string;
  feePerKb: number;
  onProgress?: (m: string) => void;
}): Promise<BuiltTx> {
  const { api, inputs, outputs, changeAddress, feePerKb, onProgress } = params;
  if (!inputs.length) throw new Error('No coins to spend.');
  if (!Number.isSafeInteger(feePerKb) || feePerKb < MIN_FEE_PER_KB || feePerKb > MAX_FEE_PER_KB) {
    throw new Error(`The fee target must be a whole number from ${MIN_FEE_PER_KB} to ${MAX_FEE_PER_KB} sats per KB.`);
  }
  let totalIn = 0;
  const selectedOutpoints = new Set<string>();
  for (const input of inputs) {
    if (!Number.isSafeInteger(input.vout) || input.vout < 0 || !Number.isSafeInteger(input.satoshis) || input.satoshis < 1) {
      throw new Error('Coin indexes and amounts must be safe, nonnegative whole numbers.');
    }
    if (!isValidAddress(input.address) || input.privateKey.toAddress().toString() !== input.address) {
      throw new Error(`The key for coin ${input.txid}:${input.vout} does not match its address.`);
    }
    const outpoint = `${input.txid}:${input.vout}`;
    if (selectedOutpoints.has(outpoint)) throw new Error(`Coin ${outpoint} was selected twice.`);
    selectedOutpoints.add(outpoint);
    totalIn += input.satoshis;
    if (!Number.isSafeInteger(totalIn)) throw new Error('The total coin amount is too large to calculate safely.');
  }
  let requested = 0;
  for (const o of outputs) {
    if (!isValidAddress(o.address)) throw new Error(`"${o.address}" isn't a valid BSV address.`);
    if (!Number.isSafeInteger(o.satoshis) || o.satoshis < 1) throw new Error('Amounts must be safe whole sats, at least 1.');
    requested += o.satoshis;
    if (!Number.isSafeInteger(requested)) throw new Error('The requested amount is too large to calculate safely.');
  }
  if (!isValidAddress(changeAddress)) throw new Error(`"${changeAddress}" isn't a valid BSV address.`);

  const sources = await loadSources(api, inputs, onProgress);
  const tx = new Transaction();
  for (const input of inputs) {
    tx.addInput({
      sourceTransaction: sources.get(input.txid)!,
      sourceOutputIndex: input.vout,
      unlockingScriptTemplate: new P2PKH().unlock(input.privateKey, 'all', false),
    });
  }
  for (const o of outputs) tx.addOutput({ lockingScript: new P2PKH().lock(o.address), satoshis: o.satoshis });
  tx.addOutput({ lockingScript: new P2PKH().lock(changeAddress), change: true });

  onProgress?.('Working out the fee and signing…');
  const feeModel = new SatoshisPerKilobyte(feePerKb);
  await tx.fee(feeModel);
  await tx.sign();

  // The SDK estimates every P2PKH unlocking script at 108 bytes. Actual DER
  // signatures are often shorter. Rebalance only the change output when the
  // final fee falls outside the target-rate band. Changing that output also
  // changes the signature and sometimes its length.
  for (let attempt = 0; attempt < 8; attempt++) {
    const signedSize = tx.toHex().length / 2;
    const signedFee = totalIn - tx.outputs.reduce((sum, output) => sum + (output.satoshis ?? 0), 0);
    const { minimum, preferred, maximum } = signedFeeBounds(signedSize, feePerKb);
    if (signedFee >= minimum && signedFee <= maximum) break;
    const change = tx.outputs.find(output => output.change === true);
    if (!change || typeof change.satoshis !== 'number') break;
    const adjusted = change.satoshis + signedFee - preferred;
    if (!Number.isSafeInteger(adjusted) || adjusted < 2) break;
    change.satoshis = adjusted;
    await tx.sign();
  }

  const hex = tx.toHex();
  const size = hex.length / 2;
  if (!Number.isSafeInteger(size) || size < 1) throw new Error('The signed transaction has an invalid size.');

  // The SDK may drop a change output if it cannot fund it. Check the complete
  // signed transaction before allowing it to be broadcast.
  if (tx.outputs.length < Math.max(1, outputs.length) || tx.outputs.length > outputs.length + 1) {
    throw new Error('The signed transaction has an unexpected number of outputs.');
  }
  let totalOut = 0;
  for (let i = 0; i < tx.outputs.length; i++) {
    const output = tx.outputs[i];
    if (typeof output.satoshis !== 'number' || !Number.isSafeInteger(output.satoshis) || output.satoshis < 1) {
      throw new Error('The signed transaction has an invalid output amount.');
    }
    if (i >= outputs.length && output.satoshis < 2) {
      throw new Error('The signed transaction leaves only 1 sat at its change or sweep destination, which this tool cannot later spend.');
    }
    const expectedAddress = i < outputs.length ? outputs[i].address : changeAddress;
    if (output.lockingScript.toHex() !== new P2PKH().lock(expectedAddress).toHex()) {
      throw new Error('The signed transaction has an unexpected destination.');
    }
    if (i < outputs.length && output.satoshis !== outputs[i].satoshis) {
      throw new Error('The signed transaction changed a requested payment amount.');
    }
    totalOut += output.satoshis;
    if (!Number.isSafeInteger(totalOut)) throw new Error('The output total is too large to calculate safely.');
  }
  const fee = totalIn - totalOut;

  // Enforce the configured rate against actual serialized, signed bytes.
  // Comparing with the model alone would accept an overestimated or dropped
  // change output as an excessive miner fee.
  const { minimum, maximum } = signedFeeBounds(size, feePerKb);
  if (fee < minimum) {
    throw new Error(`Not enough funds: you have ${totalIn} sats, but this needs ${requested} sats plus at least a ${minimum}-sat fee.`);
  }
  if (fee > maximum) throw new Error(`The fee came out at ${fee} sats, above the ${maximum}-sat upper tolerance for this signed transaction, so we stopped.`);
  for (let i = 0; i < tx.inputs.length; i++) {
    const input = tx.inputs[i];
    const script = input.unlockingScript;
    if (!script) throw new Error(`Coin ${i + 1} couldn't be signed, so we stopped.`);
    if (script.chunks[0]?.data?.at(-1) !== 0x41) {
      throw new Error(`Coin ${i + 1} was not signed with SIGHASH_ALL | FORKID.`);
    }
    const source = input.sourceTransaction!;
    const sourceOutput = source.outputs[input.sourceOutputIndex];
    if (!new Spend({
      sourceTXID: source.id('hex'), sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis: sourceOutput.satoshis!, lockingScript: sourceOutput.lockingScript,
      transactionVersion: tx.version, otherInputs: tx.inputs.filter((_, index) => index !== i),
      outputs: tx.outputs, inputIndex: i, unlockingScript: script,
      inputSequence: input.sequence ?? 0xffffffff, lockTime: tx.lockTime,
    }).validate()) throw new Error(`Coin ${i + 1} failed signature verification.`);
  }

  return { tx, hex, txid: tx.id('hex'), totalIn, totalOut, fee, size };
}
