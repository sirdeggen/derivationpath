import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { WalletClient } from '@bsv/sdk';
import { AtSign, Layers, Loader2, PenLine, ScanSearch, SearchX, Send, Wallet, X } from 'lucide-react';
import { useApp } from '../state';
import { isValidAddress, presetById, templateHasChain } from '../lib/derive';
import { scanForUtxos, templatesForScan, type AddressHit } from '../lib/scan';
import { buildP2pkhTransaction, type BuiltTx } from '../lib/tx';
import { matchesRecoveryReceipt, prepareBrc100Sweep, sendPreparedBrc100Sweep, type PreparedBrc100Sweep, type RecoveryReceipt } from '../lib/brc100';
import { shieldNote } from '../lib/tokens';
import { downloadJson } from '../lib/vault';
import { clamp, fmtSats, fmtUsd, safeInt } from '../lib/format';
import { Empty, SectionLabel, SectionTitle, Status, TxLink } from './ui';
import { useTask } from '../hooks/useTask';
import { LabelWithInfo } from './InfoTip';
import { OptionIcon, Select } from './Select';
import { WalletIcon } from './PresetPicker';
import { Brc43RecoveryPanel } from './Brc43RecoveryPanel';

const brc100Wallet = new WalletClient();

type Scope = 'selected' | 'all';
type Destination = 'brc100' | 'address';

export function RecoverPanel() {
  const app = useApp();
  const { session, selection, api, settings, price } = app;
  const [scope, setScope] = useState<Scope>('selected');
  const [gapLimit, setGapLimit] = useState('20');
  const [startOffset, setStartOffset] = useState('0');
  const [maxPerChain, setMaxPerChain] = useState('1000');
  const [includeChange, setIncludeChange] = useState(true);
  const [hits, setHits] = useState<AddressHit[]>([]);
  const [scanComplete, setScanComplete] = useState(false);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [destination, setDestination] = useState<Destination>('brc100');
  const [destAddress, setDestAddress] = useState('');
  const [built, setBuilt] = useState<{ tx: BuiltTx; address: string } | null>(null);
  const [destinationWords, setDestinationWords] = useState('');
  const [destinationPassphrase, setDestinationPassphrase] = useState('');
  const [recoveryDate, setRecoveryDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [preparedBrc, setPreparedBrc] = useState<PreparedBrc100Sweep | null>(null);
  const [receiptSaved, setReceiptSaved] = useState(false);
  const [backupConfirmed, setBackupConfirmed] = useState(false);
  const [done, setDone] = useState<{ txid: string; hex: string; receipt?: RecoveryReceipt } | null>(null);
  const addressRevision = useRef(0);
  const brcRevision = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const scanTask = useTask('No recovery scan has run.');
  const sweepTask = useTask('');
  const invalidatePreparedBrc = useCallback(() => {
    brcRevision.current++;
    setPreparedBrc(null);
    setReceiptSaved(false);
    setBackupConfirmed(false);
  }, []);

  // Unmount (lock / clear wallet) must stop a scan that still holds the root key.
  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    abortRef.current?.abort();
    setHits([]);
    setScanComplete(false);
    setBuilt(null);
    invalidatePreparedBrc();
  }, [selection.template, invalidatePreparedBrc]);

  const invalidateScan = () => {
    abortRef.current?.abort();
    setHits([]);
    setScanComplete(false);
    setBuilt(null);
    invalidatePreparedBrc();
    scanTask.setStatus('Scan options changed. Scan again before moving coins.');
  };

  const templates = templatesForScan(selection.template, scope === 'all');
  const chosen = useMemo(() => hits.filter(h => !excluded.has(h.address) && h.utxos.length), [hits, excluded]);
  const inputs = useMemo(() => chosen.flatMap(h => h.utxos), [chosen]);
  const chosenTotal = inputs.reduce((s, u) => s + u.satoshis, 0);

  const scan = () => scanTask.run(async () => {
    if (!session) throw new Error('Load a wallet first.');
    const controller = new AbortController();
    abortRef.current = controller;
    setHits([]);
    setScanComplete(false);
    setExcluded(new Set());
    setBuilt(null);
    invalidatePreparedBrc();
    setDone(null);
    sweepTask.setStatus('');
    try {
      const summary = await scanForUtxos({
        api, root: session.root, templates, includeChange,
        gapLimit: clamp(safeInt(gapLimit, 20), 1, 3500),
        startOffset: safeInt(startOffset),
        maxPerChain: clamp(safeInt(maxPerChain, 1000), 1, 10_000),
        signal: controller.signal,
        onProgress: m => scanTask.setStatus(m),
      });
      if (controller.signal.aborted) throw new Error('Scan stopped.');
      const total = summary.hits.reduce((s, h) => s + h.balance, 0);
      const utxoCount = summary.hits.reduce((s, h) => s + h.utxos.length, 0);
      const cappedEarly = summary.cappedChains.length > 0;
      const capped = cappedEarly ? ` Stopped at the address limit on ${summary.cappedChains.join(', ')}. Raise "Max addresses per list" and scan again before moving coins.` : '';
      scanTask.setStatus(
        `${cappedEarly ? 'Scan incomplete.' : 'Done.'} Checked ${summary.addressesChecked} address(es), ${summary.usedAddresses} used before. Found ${fmtSats(total)} sats (${fmtUsd(total, price)}) in ${utxoCount} coin(s).${shieldNote(summary.protectedTotal)}${capped}`,
        cappedEarly ? 'warn' : utxoCount ? 'success' : 'warn');
      setHits(summary.hits);
      setScanComplete(!cappedEarly);
    } finally {
      abortRef.current = null;
    }
  });

  const toggle = (address: string) => {
    setBuilt(null);
    invalidatePreparedBrc();
    setExcluded(prev => {
      const next = new Set(prev);
      if (next.has(address)) next.delete(address); else next.add(address);
      return next;
    });
  };

  const afterSweep = (txid: string, hex: string, message: string, receipt?: RecoveryReceipt) => {
    // Clear results so the same coins can't be swept twice.
    setHits([]);
    setScanComplete(false);
    setExcluded(new Set());
    setBuilt(null);
    invalidatePreparedBrc();
    setDone({ txid, hex, receipt });
    sweepTask.setStatus(message, 'success');
  };

  const prepareBrc100 = () => sweepTask.run(async () => {
    invalidatePreparedBrc();
    if (!inputs.length) throw new Error('Select at least one address to move.');
    const revision = brcRevision.current;
    const words = destinationWords;
    const passphrase = destinationPassphrase;
    setDestinationWords('');
    setDestinationPassphrase('');
    const prepared = await prepareBrc100Sweep({
      api, wallet: brc100Wallet, inputs,
      destinationMnemonic: words, destinationPassphrase: passphrase,
      day: recoveryDate, onProgress: m => sweepTask.setStatus(m),
    });
    if (revision !== brcRevision.current) {
      try { await brc100Wallet.abortAction({ reference: prepared.reference }); } catch { /* Wallet may expire the action. */ }
      throw new Error('The source or destination changed while preparing. Prepare again.');
    }
    setPreparedBrc(prepared);
    sweepTask.setStatus(`Ready. ${fmtSats(prepared.receipt.satoshis)} sats will go to ${prepared.receipt.address} with a ${fmtSats(prepared.receipt.fee)}-sat fee. Save the receipt and review it before sending.`, 'success');
  });

  const verifyReceipt = (file?: File) => sweepTask.run(async () => {
    brcRevision.current++;
    setReceiptSaved(false);
    if (!preparedBrc || !file) throw new Error('Choose the recovery receipt you saved.');
    if (file.size > 64_000) throw new Error('The recovery receipt file is unexpectedly large.');
    let candidate: unknown;
    try { candidate = JSON.parse(await file.text()); } catch { throw new Error('That is not a valid JSON recovery receipt.'); }
    if (!matchesRecoveryReceipt(candidate, preparedBrc.receipt)) {
      throw new Error('That receipt does not match the exact destination and transaction being prepared.');
    }
    setReceiptSaved(true);
    sweepTask.setStatus('Saved recovery receipt verified. Review the address and confirm your phrase backup before sending.', 'success');
  });

  const sendBrc100 = () => sweepTask.run(async () => {
    if (!preparedBrc) throw new Error('Prepare the BRC-100 transaction first.');
    if (!receiptSaved || !backupConfirmed) throw new Error('Verify the saved recovery receipt and confirm your destination phrase is backed up first.');
    const revision = brcRevision.current;
    const { receipt } = preparedBrc;
    if (!(await app.confirm('Send to backed-up dated key?', `${fmtSats(receipt.satoshis)} sats will go to ${receipt.address} (key ID ${receipt.keyID}) with a ${fmtSats(receipt.fee)}-sat fee. This output may not show in your wallet's ordinary balance. This cannot be undone.`))) return;
    if (revision !== brcRevision.current) throw new Error('Recovery details changed during confirmation. Review and confirm again.');
    sweepTask.setStatus('Sending the reviewed transaction…', 'warn');
    const { txid, hex } = await sendPreparedBrc100Sweep(brc100Wallet, preparedBrc);
    afterSweep(txid, hex, `Sent to your backed-up dated key. Transaction ID: ${txid}`, receipt);
  });

  const buildToAddress = () => sweepTask.run(async () => {
    setBuilt(null);
    if (!inputs.length) throw new Error('Select at least one address to move.');
    const dest = destAddress.trim();
    const revision = addressRevision.current;
    if (!isValidAddress(dest)) throw new Error("That destination address isn't valid.");
    const tx = await buildP2pkhTransaction({
      api, inputs, outputs: [], changeAddress: dest, feePerKb: settings.feePerKb,
      onProgress: m => sweepTask.setStatus(m),
    });
    if (revision !== addressRevision.current) throw new Error('The destination changed while preparing. Prepare the transaction again.');
    setBuilt({ tx, address: dest });
    sweepTask.setStatus(
      `Ready. ${fmtSats(tx.totalOut)} sats will arrive at ${dest} after a ${fmtSats(tx.fee)}-sat fee. Check it, then press Send now.`,
      'success');
  });

  const broadcastToAddress = () => sweepTask.run(async () => {
    if (!built) throw new Error('Prepare the transaction first.');
    const { tx, address } = built;
    const revision = addressRevision.current;
    if (address !== destAddress.trim()) throw new Error('The destination changed. Prepare the transaction again.');
    if (!(await app.confirm('Send now?', `This can't be undone. ${fmtSats(tx.totalOut)} sats will go to ${address} with a ${fmtSats(tx.fee)}-sat fee.`))) return;
    if (revision !== addressRevision.current || address !== destAddress.trim()) throw new Error('The destination changed. Prepare the transaction again.');
    sweepTask.setStatus('Sending…', 'warn');
    let txid: string;
    try { txid = await api.woc.broadcast(tx.hex); }
    catch (error) { throw new Error(`Broadcast status is uncertain. Check ${tx.txid} before retrying: ${(error as Error).message}`); }
    if (txid.toLowerCase() !== tx.txid.toLowerCase()) {
      throw new Error(`The broadcaster returned a different transaction ID. Check ${tx.txid} before retrying.`);
    }
    afterSweep(txid, tx.hex, `Sent! Transaction ID: ${txid}`);
  });

  const busy = scanTask.busy || sweepTask.busy;

  const hasFunds = scanComplete && inputs.length > 0 && !scanTask.busy;
  const totalBalance = hits.reduce((s, h) => s + h.balance, 0);
  const totalUtxos = hits.reduce((s, h) => s + h.utxos.length, 0);
  const totalProtected = hits.reduce((s, h) => s + h.protectedCount, 0);

  return (
    <div className="card"><div className="card-body">
      <SectionTitle title="Find & recover" icon={ScanSearch}>We check your addresses one by one for coins, then move selected coins to a backed-up dated key or any address you choose.</SectionTitle>

      <SectionLabel>Scan options</SectionLabel>
      <div className="grid-2">
        <div className="field full">
          <LabelWithInfo htmlFor="scanScope" label="Paths to scan" info="Which recipe to use to find your addresses. &quot;Your selected path&quot; checks only the one from the Wallet tab. &quot;Every wallet we know&quot; tries them all: slower, but handy if you&apos;re not sure which app you used." />
          <Select id="scanScope" value={scope} onChange={value => { setScope(value); invalidateScan(); }} options={[
            { value: 'selected', prefix: presetById(selection.presetId)?.name ?? 'Custom', label: 'Your selected path', detail: selection.template, icon: <WalletIcon preset={presetById(selection.presetId)} /> },
            { value: 'all', label: 'Every wallet we know', detail: `${templatesForScan(selection.template, true).length} paths, slower`, icon: <OptionIcon><Layers size={13} /></OptionIcon> },
          ]} />
        </div>
      </div>
      <div className="grid-3" style={{ marginTop: 16 }}>
        <div className="field"><LabelWithInfo htmlFor="gapLimit" label="Gap limit" info="Wallets use addresses in order. We keep checking until we find this many unused addresses in a row, then assume there are no more. Centbee can skip thousands of addresses; for a deep recovery, try 3500 and raise Max addresses per list above that too." />
          <input id="gapLimit" type="number" min={1} max={3500} value={gapLimit} onChange={e => { setGapLimit(e.target.value); invalidateScan(); }} />
          <div className="hint">Stop after this many empty addresses in a row. A deeper scan needs a higher address limit too.</div></div>
        <div className="field"><LabelWithInfo htmlFor="startOffset" label="Start at address #" info="Where to start counting. Leave it at 0 unless you know your coins are further down the list." />
          <input id="startOffset" type="number" min={0} value={startOffset} onChange={e => { setStartOffset(e.target.value); invalidateScan(); }} /></div>
        <div className="field"><LabelWithInfo htmlFor="maxPerChain" label="Max addresses per list" info="A safety limit so a scan can&apos;t run forever. Each list (receive and change) stops here, even if it keeps finding used addresses." />
          <input id="maxPerChain" type="number" min={1} max={10000} value={maxPerChain} onChange={e => { setMaxPerChain(e.target.value); invalidateScan(); }} /></div>
      </div>
      <label className="toggle" style={{ marginTop: 16 }}><input type="checkbox" checked={includeChange} onChange={e => { setIncludeChange(e.target.checked); invalidateScan(); }}
        disabled={scope === 'selected' && !templateHasChain(selection.template)} /> Also check change addresses</label>

      <div className="actions">
        <button className={`btn ${hasFunds ? 'btn-secondary' : 'btn-primary'}`} disabled={busy || !session} onClick={scan}>
          {scanTask.busy ? <Loader2 size={16} className="spin" /> : <ScanSearch size={16} />} {hits.length ? 'Scan again' : 'Scan for coins'}
        </button>
        {scanTask.busy && <button className="btn btn-ghost" onClick={() => abortRef.current?.abort()}><X size={16} /> Cancel</button>}
      </div>
      <Status status={scanTask.status} />

      {hits.length > 0 && (
        <>
          <SectionLabel>Funded addresses</SectionLabel>
          <div className="table-wrap">
            <table className="utxo-table">
              <thead><tr><th aria-label="Include" /><th>Path</th><th>Address</th><th className="num">Sats</th><th className="num">Coins</th><th className="num" title="Coins holding NFTs or tokens. We leave these alone so they stay safe.">NFTs/tokens</th></tr></thead>
              <tbody>
                {hits.map(h => (
                  <tr key={h.address} className={h.utxos.length ? '' : 'muted'}>
                    <td><input type="checkbox" aria-label={`Include ${h.address}`} disabled={!h.utxos.length || busy}
                      checked={!!h.utxos.length && !excluded.has(h.address)} onChange={() => toggle(h.address)} /></td>
                    <td className="mono">{h.path}</td>
                    <td className="mono">{h.address}</td>
                    <td className="num">{fmtSats(h.balance)}</td>
                    <td className="num">{h.utxos.length}</td>
                    <td className="num">{h.protectedCount || '–'}</td>
                  </tr>
                ))}
              </tbody>
              {hits.length > 1 && (
                <tfoot><tr><td /><td colSpan={2}>Total</td><td className="num">{fmtSats(totalBalance)}</td><td className="num">{totalUtxos}</td><td className="num">{totalProtected || '–'}</td></tr></tfoot>
              )}
            </table>
          </div>
        </>
      )}
      {!scanTask.busy && hits.length === 0 && scanTask.status.type === 'warn' && <div className="result-list"><Empty icon={SearchX}>No coins found at the addresses we checked.</Empty></div>}

      {hasFunds && (
        <div className="sweep-box">
          <div className="label-caps">Ready to move</div>
          <div className="sweep-total">{fmtSats(chosenTotal)} <small>sats · {fmtUsd(chosenTotal, price)} · {inputs.length} coin(s)</small></div>
          <div className="segmented" role="radiogroup" aria-label="Sweep destination" style={{ marginTop: 14 }}>
            <label className={destination === 'brc100' ? 'on' : ''}><input type="radio" name="dest" checked={destination === 'brc100'} onChange={() => { setDestination('brc100'); setBuilt(null); }} /><Wallet size={15} /> Backed-up dated key</label>
            <label className={destination === 'address' ? 'on' : ''}><input type="radio" name="dest" checked={destination === 'address'} onChange={() => { setDestination('address'); invalidatePreparedBrc(); }} /><AtSign size={15} /> Any BSV address</label>
          </div>

          {destination === 'brc100' ? (
            <>
              <p className="mini" style={{ marginTop: 14 }}>Open your destination BRC-100 wallet and enter its backed-up seed phrase below. We check that the wallet's identity and dated BRC-43 key can be re-created from those words before signing. The payment goes only to that key. This custom output may not appear in the wallet's ordinary balance; use the dated-output recovery section below with your backup and receipt to find and move it later.</p>
              <div className="grid-2" style={{ marginTop: 14 }}>
                <div className="field full"><LabelWithInfo htmlFor="destinationWords" label="Destination wallet seed phrase" info="The backup for the wallet receiving your funds. It stays in this browser and is cleared after preparation. Keep your own offline copy; this app does not save it." />
                  <input id="destinationWords" type="password" autoComplete="off" spellCheck={false} value={destinationWords} disabled={busy} onChange={e => { setDestinationWords(e.target.value); invalidatePreparedBrc(); }} placeholder="12 or 24 words from the receiving wallet" /></div>
                <div className="field"><LabelWithInfo htmlFor="destinationPassphrase" label="Destination BIP-39 passphrase, if any" info="Use the passphrase associated with the destination wallet seed phrase. Leave blank if it has none." />
                  <input id="destinationPassphrase" type="password" autoComplete="off" value={destinationPassphrase} disabled={busy} onChange={e => { setDestinationPassphrase(e.target.value); invalidatePreparedBrc(); }} /></div>
                <div className="field"><LabelWithInfo htmlFor="recoveryDate" label="Recovery key date (UTC)" info="This date becomes the public BRC-43 key ID. The same wallet backup, protocol and date always derive the same address. Save it in the receipt." />
                  <input id="recoveryDate" type="date" value={recoveryDate} disabled={busy} onChange={e => { setRecoveryDate(e.target.value); invalidatePreparedBrc(); }} /></div>
              </div>
              <div className="actions"><button className={`btn ${preparedBrc ? 'btn-secondary' : 'btn-primary'}`} disabled={busy} onClick={prepareBrc100}><PenLine size={16} /> Prepare wallet transaction</button></div>
              {preparedBrc && <div className="field" style={{ marginTop: 16 }}>
                <label>Verified destination and fee</label>
                <p className="mini">{fmtSats(preparedBrc.receipt.satoshis)} sats to <b className="mono">{preparedBrc.receipt.address}</b>; miner fee {fmtSats(preparedBrc.receipt.fee)} sats. Root: {preparedBrc.receipt.rootScheme}. BRC-43 protocol: <span className="mono">0-derivation path recovery</span>; key ID: <span className="mono">{preparedBrc.receipt.keyID}</span>; counterparty: self.</p>
                <p className="mini">The receipt contains the public keys and exact address needed to identify this output later. The destination seed phrase and any passphrase must be backed up separately. This output may not appear in your wallet's ordinary balance.</p>
                <div className="actions"><button className="btn btn-secondary" disabled={busy} onClick={() => downloadJson(`derivation-path-recovery-${preparedBrc.receipt.keyID}-${preparedBrc.receipt.txid}.json`, preparedBrc.receipt)}>Download recovery receipt</button></div>
                <div className="field" style={{ marginTop: 12 }}><label htmlFor="savedRecoveryReceipt">Verify the saved receipt file</label>
                  <input id="savedRecoveryReceipt" type="file" accept="application/json,.json" disabled={busy} onChange={e => void verifyReceipt(e.target.files?.[0])} />
                  <div className="hint">Choose the file from where you saved it. This confirms the date and address are recorded outside this page. {receiptSaved ? 'Verified.' : ''}</div></div>
                <label className="toggle" style={{ marginTop: 12 }}><input type="checkbox" checked={backupConfirmed} onChange={e => { brcRevision.current++; setBackupConfirmed(e.target.checked); }} /> I have an offline backup of the destination phrase and passphrase.</label>
                <div className="actions"><button className="btn btn-ink" disabled={busy || !receiptSaved || !backupConfirmed} onClick={sendBrc100}><Send size={16} /> Send reviewed transaction</button></div>
                <label htmlFor="brc100Raw">Signed transaction · <span className="mono muted">{preparedBrc.receipt.txid}</span></label>
                <textarea id="brc100Raw" className="mono" readOnly value={preparedBrc.hex} />
              </div>}
            </>
          ) : (
            <>
              <div className="field" style={{ marginTop: 14 }}><LabelWithInfo htmlFor="recoveryDestination" label="Destination address" info="The BSV address that receives everything we found, minus a small network fee. Double-check it: once sent, it can&apos;t be undone." />
                <input id="recoveryDestination" spellCheck={false} value={destAddress} onChange={e => { addressRevision.current++; setDestAddress(e.target.value); setBuilt(null); }} placeholder="The BSV address that gets everything" /></div>
              <p className="mini">Only use an address whose private key or seed phrase and derivation path you have backed up. This tool cannot verify ownership of an address you paste.</p>
              <div className="actions">
                <button className={`btn ${built ? 'btn-secondary' : 'btn-primary'}`} disabled={busy} onClick={buildToAddress}><PenLine size={16} /> Prepare transaction</button>
                <button className="btn btn-ink" disabled={busy || !built} onClick={broadcastToAddress}><Send size={16} /> Send now</button>
              </div>
              {built && <div className="field" style={{ marginTop: 16 }}><label htmlFor="recoveryRaw">Signed transaction · <span className="mono muted">{built.tx.txid}</span></label><textarea id="recoveryRaw" className="mono" readOnly value={built.tx.hex} /></div>}
            </>
          )}
        </div>
      )}
      {(sweepTask.status.text || done) && <Status status={sweepTask.status} />}
      {done && (
        <div className="tx-result">
          <TxLink txid={done.txid} label="View on WhatsOnChain ↗" />
          {done.receipt && <pre className="tx-hex">Recovery receipt (public data):{`\n${JSON.stringify(done.receipt, null, 2)}`}</pre>}
          <pre className="tx-hex">{done.hex}</pre>
        </div>
      )}
      <Brc43RecoveryPanel />
    </div></div>
  );
}
