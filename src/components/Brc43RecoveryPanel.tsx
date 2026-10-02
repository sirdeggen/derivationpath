import { useEffect, useRef, useState } from 'react';
import { FileJson, Loader2, PenLine, ScanSearch, Send, X } from 'lucide-react';
import { useApp } from '../state';
import { useTask } from '../hooks/useTask';
import { isValidAddress } from '../lib/derive';
import {
  deriveDatedRecoveryKey, parseDatedRecoveryReceipt, prepareDatedRecoverySweep,
  scanDatedRecoveryOutput, type DatedRecoveryScan,
} from '../lib/brc43-recovery';
import type { RecoveryReceipt, RootScheme } from '../lib/brc100';
import { fmtSats } from '../lib/format';
import { shieldNote } from '../lib/tokens';
import { SectionLabel, Status, TxLink } from './ui';

interface Prepared {
  hex: string;
  txid: string;
  address: string;
  totalOut: number;
  fee: number;
}

const SECRET_IDLE_MS = 2 * 60 * 1000;

/** Recovers this app's dated BRC-43 output without the destination wallet software. */
export function Brc43RecoveryPanel() {
  const { api, settings, confirm } = useApp();
  const [receiptText, setReceiptText] = useState('');
  const [receipt, setReceipt] = useState<RecoveryReceipt | null>(null);
  const [rootScheme, setRootScheme] = useState<RootScheme>('BRC-157');
  const [day, setDay] = useState(() => new Date().toISOString().slice(0, 10));
  const [expectedAddress, setExpectedAddress] = useState('');
  const [mnemonic, setMnemonic] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [scanResult, setScanResult] = useState<DatedRecoveryScan | null>(null);
  const [destinationAddress, setDestinationAddress] = useState('');
  const [backupConfirmed, setBackupConfirmed] = useState(false);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [sentTxid, setSentTxid] = useState('');
  const scanAbort = useRef<AbortController | null>(null);
  const destinationRevision = useRef(0);
  const operationRevision = useRef(0);
  const task = useTask('');
  const setTaskStatus = task.setStatus;

  useEffect(() => () => scanAbort.current?.abort(), []);
  useEffect(() => {
    if (!mnemonic && !passphrase) return;
    let idle: ReturnType<typeof setTimeout>;
    const clearSecrets = () => {
      operationRevision.current++;
      scanAbort.current?.abort();
      setMnemonic('');
      setPassphrase('');
      setScanResult(null);
      setPrepared(null);
      setBackupConfirmed(false);
      setTaskStatus('The recovery phrase was cleared after inactivity or when the tab was hidden. Re-enter it and scan again.', 'warn');
    };
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(clearSecrets, SECRET_IDLE_MS);
    };
    const onVisibility = () => { if (document.visibilityState === 'hidden') clearSecrets(); };
    const events = ['mousemove', 'keydown', 'touchstart', 'focus', 'click', 'scroll'] as const;
    events.forEach(event => window.addEventListener(event, armIdle, { passive: true }));
    document.addEventListener('visibilitychange', onVisibility);
    armIdle();
    return () => {
      clearTimeout(idle);
      events.forEach(event => window.removeEventListener(event, armIdle));
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [mnemonic, passphrase, setTaskStatus]);

  const invalidateScan = () => {
    operationRevision.current++;
    scanAbort.current?.abort();
    setScanResult(null);
    setPrepared(null);
    setBackupConfirmed(false);
    setSentTxid('');
  };

  const loadReceipt = () => {
    try {
      const parsed = parseDatedRecoveryReceipt(receiptText);
      invalidateScan();
      setReceipt(parsed);
      setRootScheme(parsed.rootScheme);
      setDay(parsed.keyID);
      setExpectedAddress(parsed.address);
      task.setStatus('Receipt loaded. Its public keys and address will be checked against your backup.', 'success');
    } catch (error) {
      task.setStatus((error as Error).message, 'error');
    }
  };

  const scan = () => task.run(async () => {
    if (receiptText.trim() && !receipt) throw new Error('Load the pasted receipt first, or clear it to use the fields manually.');
    invalidateScan();
    const revision = operationRevision.current;
    const words = mnemonic;
    const extra = passphrase;
    setMnemonic('');
    setPassphrase('');
    const key = deriveDatedRecoveryKey({
      mnemonic: words, passphrase: extra, rootScheme, day, expectedAddress,
    });
    if (receipt && (receipt.rootScheme !== rootScheme || receipt.keyID !== day ||
      receipt.address !== key.address || receipt.identityPublicKey !== key.identityPublicKey ||
      receipt.destinationPublicKey !== key.destinationPublicKey)) {
      throw new Error('The backup does not reproduce the public keys and address in the loaded receipt.');
    }
    const controller = new AbortController();
    scanAbort.current = controller;
    try {
      task.setStatus(`Checking dated recovery address ${key.address} and token protection…`);
      const result = await scanDatedRecoveryOutput(api, key, controller.signal);
      if (controller.signal.aborted || revision !== operationRevision.current) throw new Error('Recovery scan stopped.');
      setScanResult(result);
      const total = result.utxos.reduce((sum, coin) => sum + coin.satoshis, 0);
      task.setStatus(`Checked ${result.address}. Found ${fmtSats(total)} sats in ${result.utxos.length} plain coin(s).${shieldNote(result.protectedCount)}`, result.utxos.length ? 'success' : 'warn');
    } finally {
      if (scanAbort.current === controller) scanAbort.current = null;
    }
  });

  const prepare = () => task.run(async () => {
    setPrepared(null);
    const revision = operationRevision.current;
    if (!scanResult?.utxos.length) throw new Error('Scan a funded dated recovery address first.');
    if (!backupConfirmed) throw new Error('Confirm that the destination address is backed up first.');
    const destination = destinationAddress.trim();
    if (!isValidAddress(destination)) throw new Error('Enter a valid mainnet BSV destination address.');
    if (destination === scanResult.address) throw new Error('Choose a different backed-up address to move these coins.');
    const words = mnemonic;
    const extra = passphrase;
    setMnemonic('');
    setPassphrase('');
    const built = await prepareDatedRecoverySweep({
      api, scan: scanResult, mnemonic: words, passphrase: extra,
      destinationAddress: destination, feePerKb: settings.feePerKb,
      onProgress: message => task.setStatus(message),
    });
    if (revision !== operationRevision.current) throw new Error('Recovery details changed while preparing. Scan and prepare again.');
    setPrepared({ hex: built.hex, txid: built.txid, address: destination, totalOut: built.totalOut, fee: built.fee });
    task.setStatus(`Ready: ${fmtSats(built.totalOut)} sats to ${destination}; miner fee ${fmtSats(built.fee)} sats. Review before sending.`, 'success');
  });

  const send = () => task.run(async () => {
    if (!prepared || !backupConfirmed) throw new Error('Prepare and review the transaction first.');
    const revision = destinationRevision.current;
    const operation = operationRevision.current;
    if (prepared.address !== destinationAddress.trim()) throw new Error('The destination changed. Prepare again.');
    if (!(await confirm('Send dated recovery coins?', `${fmtSats(prepared.totalOut)} sats will go to ${prepared.address} with a ${fmtSats(prepared.fee)}-sat fee. This cannot be undone.`))) return;
    if (revision !== destinationRevision.current || operation !== operationRevision.current || prepared.address !== destinationAddress.trim()) throw new Error('The recovery details changed. Prepare again.');
    task.setStatus('Broadcasting the reviewed transaction…', 'warn');
    let txid: string;
    try {
      txid = await api.woc.broadcast(prepared.hex);
    } catch (error) {
      throw new Error(`Broadcast status is uncertain. Check ${prepared.txid} before retrying: ${(error as Error).message}`);
    }
    if (txid.toLowerCase() !== prepared.txid.toLowerCase()) {
      throw new Error(`The broadcaster returned a different transaction ID. Check ${prepared.txid} before retrying.`);
    }
    if (operation !== operationRevision.current) throw new Error(`The recovery details changed during broadcast. Check ${prepared.txid} before retrying.`);
    setSentTxid(prepared.txid);
    setPrepared(null);
    setScanResult(null);
    task.setStatus(`Sent to ${destinationAddress.trim()}. Transaction ID: ${txid}`, 'success');
  });

  const total = scanResult?.utxos.reduce((sum, coin) => sum + coin.satoshis, 0) ?? 0;
  return (
    <div className="sweep-box" style={{ marginTop: 26 }}>
      <SectionLabel>Recover this tool’s dated BRC-43 output</SectionLabel>
      <p className="mini">If your BRC-100 wallet disappears, this route derives the dated output directly from its backed-up phrase. No wallet connection or loaded source wallet is needed. Use the root scheme and UTC date from your recovery receipt; repeat for each date used.</p>
      <div className="field" style={{ marginTop: 14 }}>
        <label htmlFor="brc43Receipt">Recovery receipt JSON (optional)</label>
        <textarea id="brc43Receipt" className="mono" value={receiptText} disabled={task.busy} onChange={e => { setReceiptText(e.target.value); setReceipt(null); invalidateScan(); task.setStatus('Receipt text changed. Load it before scanning, or clear it to enter values manually.'); }} placeholder="Paste your saved recovery receipt to fill and verify the public details" />
        <div className="actions"><button className="btn btn-secondary" disabled={task.busy || !receiptText.trim()} onClick={loadReceipt}><FileJson size={16} /> Load receipt</button></div>
      </div>
      <div className="grid-3" style={{ marginTop: 14 }}>
        <div className="field"><label htmlFor="brc43Scheme">Root scheme</label>
          <select id="brc43Scheme" value={rootScheme} disabled={task.busy} onChange={e => { setRootScheme(e.target.value as RootScheme); setReceipt(null); invalidateScan(); }}>
            <option value="BRC-157">BRC-157</option><option value="BRC-75">BRC-75</option>
          </select></div>
        <div className="field"><label htmlFor="brc43Day">Recovery key date (UTC)</label>
          <input id="brc43Day" type="date" value={day} disabled={task.busy} onChange={e => { setDay(e.target.value); setReceipt(null); invalidateScan(); }} /></div>
        <div className="field"><label htmlFor="brc43Expected">Receipt address (optional)</label>
          <input id="brc43Expected" className="mono" value={expectedAddress} disabled={task.busy} onChange={e => { setExpectedAddress(e.target.value); setReceipt(null); invalidateScan(); }} placeholder="1…" /></div>
      </div>
      <div className="grid-2" style={{ marginTop: 14 }}>
        <div className="field"><label htmlFor="brc43Words">Destination wallet seed phrase</label>
          <input id="brc43Words" type="password" autoComplete="off" spellCheck={false} value={mnemonic} disabled={task.busy} onChange={e => { operationRevision.current++; setMnemonic(e.target.value); setPrepared(null); }} placeholder="Re-enter for scan and again for signing" /></div>
        <div className="field"><label htmlFor="brc43Passphrase">BIP-39 passphrase, if any</label>
          <input id="brc43Passphrase" type="password" autoComplete="off" value={passphrase} disabled={task.busy} onChange={e => { operationRevision.current++; setPassphrase(e.target.value); setPrepared(null); }} /></div>
      </div>
      <p className="mini">The phrase and passphrase are cleared after each scan or signing attempt. Only the public address and coin list remain between steps.</p>
      <div className="actions">
        <button className="btn btn-primary" disabled={task.busy || !mnemonic.trim() || (!!receiptText.trim() && !receipt)} onClick={scan}>{task.busy ? <Loader2 size={16} className="spin" /> : <ScanSearch size={16} />} Scan dated output</button>
        {scanAbort.current && task.busy && <button className="btn btn-ghost" onClick={() => scanAbort.current?.abort()}><X size={16} /> Cancel</button>}
      </div>
      {scanResult && <>
        <p className="mini">Derived address: <b className="mono">{scanResult.address}</b>. Plain BSV: {fmtSats(total)} sats in {scanResult.utxos.length} coin(s).{shieldNote(scanResult.protectedCount)}</p>
        {scanResult.utxos.length > 0 && <>
          <div className="field"><label htmlFor="brc43Destination">Backed-up BSV destination address</label>
            <input id="brc43Destination" className="mono" spellCheck={false} value={destinationAddress} disabled={task.busy} onChange={e => { operationRevision.current++; destinationRevision.current++; setDestinationAddress(e.target.value); setPrepared(null); setBackupConfirmed(false); }} placeholder="The address that will receive every plain coin" /></div>
          <label className="toggle"><input type="checkbox" checked={backupConfirmed} disabled={task.busy} onChange={e => { operationRevision.current++; setBackupConfirmed(e.target.checked); setPrepared(null); }} /> I control this destination and have backed up its key, seed phrase and derivation path.</label>
          <div className="actions"><button className="btn btn-secondary" disabled={task.busy || !mnemonic.trim() || !backupConfirmed} onClick={prepare}><PenLine size={16} /> Prepare signed sweep</button></div>
        </>}
      </>}
      {prepared && <div className="field" style={{ marginTop: 14 }}>
        <label>Reviewed transaction</label>
        <p className="mini">{fmtSats(prepared.totalOut)} sats to <b className="mono">{prepared.address}</b>; miner fee {fmtSats(prepared.fee)} sats.</p>
        <div className="actions"><button className="btn btn-ink" disabled={task.busy || !backupConfirmed} onClick={send}><Send size={16} /> Send reviewed transaction</button></div>
        <label htmlFor="brc43Raw">Signed transaction · <span className="mono muted">{prepared.txid}</span></label>
        <textarea id="brc43Raw" className="mono" readOnly value={prepared.hex} />
      </div>}
      {sentTxid && <p className="mini">Recovery sent: <TxLink txid={sentTxid} /></p>}
      <Status status={task.status} />
    </div>
  );
}
