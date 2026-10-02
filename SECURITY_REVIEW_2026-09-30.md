# Fund-loss adversarial review — September 30, 2026

Fee policy updated October 2, 2026 at the user's request.

This review covers BSV recovery and sending from BIP-39 phrases in the current React application. It focuses on destination ownership, fee burns, output integrity, recoverability after wallet software loss, and incomplete discovery. It does not certify third-party wallets, miners, APIs, or a deployed build.

## Findings and changes

| Risk found | Prior behavior | Current safeguard |
| --- | --- | --- |
| Wallet-selected destination | `src/lib/brc100.ts` called `createAction` with external inputs and no requested output, then signed the wallet's result. A low fee did not prove that an output belonged to the user. | The receiving wallet's BRC-43 public key is checked against a backed-up destination mnemonic. `createAction` receives exactly one P2PKH output, and its returned transaction must contain that exact script and amount, every selected input once, and no extras before signing. |
| Unrecoverable output key | The wallet chose an undisclosed output key and the app saved no recovery metadata. | The dated-key flow uses self-derivation with protocol `[0, 'derivation path recovery']` and a user-selected UTC `YYYY-MM-DD` key ID. The app verifies the destination wallet identity under BRC-157 or BRC-75, then verifies the derived key against the wallet. A public receipt records the scheme, key ID, identity and child public keys, address, amount, fee, and txid. No random key ID or BRC-29 prefix/suffix is used. The user must separately back up the destination phrase and passphrase. A separate recovery panel derives and spends this key without the wallet software. |
| Unverified receipt download | Clicking a browser download link was treated as proof the dated key's recovery metadata had been saved. | Sending requires the user to re-open the saved JSON file; every public receipt field is matched against the prepared transaction. Destination words and passphrase are cleared from the input on every preparation attempt. |
| Custom output confused with wallet balance | Wallet Toolbox records an explicit `createAction` output as a custom basket output, which its ordinary wallet balance does not automatically include. | The UI calls it a backed-up dated key and warns that it may not appear in ordinary wallet balance. The independent recovery panel scans and sweeps its P2PKH address. The flow does not claim to be a BRC-29 wallet payment. |
| Excess miner fee | Settings allowed up to 100,000 sat/kB; the BRC-100 path allowed 1,000 sat/kB; the local builder tolerated a large absolute or relative fee surplus. | The default and dated-key destination target is 100 sat/kB; local sends can target 90–110 sat/kB. The final signed fee must be within 10 sat/kB of the selected target and within the overall 90–110 sat/kB band, with whole-satoshi rounding. The local builder adjusts change and re-signs when the SDK's size estimate differs. Invalid, unexpected, and 1-sat implicit change or sweep outputs are rejected. |
| Mutable payment review | Editing the recipient or amount after preparing a send left a previously signed transaction available; confirmation text could show the edited values. | Editing invalidates the prepared transaction, asynchronous builds use a revision guard, and confirmation uses the immutable prepared recipient, amount and fee. Recovery-to-address applies the same destination revision check. |
| Partial scan treated as spendable | Funded hits were published while a scan was running. If the scan failed or was canceled, those hits remained eligible for sweep. A chain stopped by the address cap could also enable sweeping. | Scan results are published only after a complete successful run. Failed, canceled, or capped scans cannot enable sweeping. Changing scan options invalidates earlier results. |
| Missed Centbee change | The Centbee preset fixed the receive chain at `m/44'/0/0/{index}`. | The preset now uses `m/44'/0/{chain}/{index}` and scans receive and change. The old fixed path remains as a legacy option. The gap limit can be raised to 3,500, with the address cap raised separately. |
| Signature scope drift | The SDK's default P2PKH signing scope was relied upon in key places. | Signing explicitly requests `all` without `ANYONECANPAY`. Every local and BRC-100 signature must carry `SIGHASH_ALL | FORKID` (`0x41`), and the signed P2PKH spends are validated against their source outputs and final transaction. |

## Recovery recipe for a dated BRC-43 output

The destination mnemonic and BIP-39 passphrase generate the wallet identity root. For **BRC-157**, use the BIP-39 seed with BIP-32 path `m/0'/0'`; the app also rejects zero or out-of-range entropy for this scheme. For **BRC-75**, use SHA-256 of the BIP-39 seed. The app tests both against the connected wallet's identity public key and refuses to sign if neither matches.

The receive key uses [BRC-42](https://bsv.brc.dev/key-derivation/0042) self-derivation and [BRC-43](https://bsv.brc.dev/key-derivation/0043) invoice number `0-derivation path recovery-YYYY-MM-DD`. The date is chosen before signing and appears in the downloaded receipt. The derived public key is converted to a mainnet P2PKH address. The receipt contains enough public data to identify and verify the output, while the phrase and passphrase remain the secret backup. If a client loses its basket metadata or disappears, the key can be re-derived from this documented scheme. The app never uses an ephemeral random prefix or suffix for the new output.

The Recover tab's **Recover this tool's dated BRC-43 output** section accepts the receipt or its public date, root scheme and address, derives the key from the destination phrase and passphrase, scans that one address, checks token protection, and signs a sweep to a user-entered backed-up address. It does not require the original wallet software or an existing source session. The user-entered **Any BSV address** option cannot prove that the user owns the destination key; both sweep interfaces warn that its private key or seed and derivation path must be backed up separately.

## Limits requiring further verification

- A BRC-100 wallet with a mnemonic-to-identity scheme other than BRC-157 or BRC-75 is refused. This is intentional until its root scheme can be independently reproduced. BSV Desktop's Wallet Toolbox [records caller-specified outputs as custom](https://raw.githubusercontent.com/bsv-blockchain/ts-stack/main/packages/wallet/wallet-toolbox/src/storage/methods/createAction.ts), and its [ordinary balance uses wallet-managed outputs](https://raw.githubusercontent.com/bsv-blockchain/ts-stack/main/packages/wallet/wallet-toolbox/src/Wallet.ts). A dated output is recoverable using this app's separate panel, but it is not promised to appear as ordinary wallet balance. A live wallet integration test is still required to verify that a particular wallet accepts the action and broadcast sequence.
- A scan stops at the chosen gap and address limits and only covers listed or user-entered BIP-32 templates. A completed scan is not proof that every address ever used by a wallet has been discovered. Vendor paths beyond the documented Centbee and RockWallet examples should be checked against each vendor's own vectors.
- NFT and token protection depends on GorillaPool's indexer and the formats it recognizes. Plain P2PKH script checks and excluding 1-sat outputs are additional safeguards, not a proof that every asset protocol is detected.
- The default and dated-key destination fee target is 100 sat/kB. Local sends, including spending a dated BRC-43 output, can choose a 90–110 sat/kB target in Settings. The app checks the signed fee against a band within 10 sat/kB of that target and the overall 90–110 sat/kB band, with whole-satoshi rounding. There is no fixed absolute satoshi cap. [Miner minimums vary](https://docs.bsvblockchain.org/network-topology/nodes/sv-node/frequently-asked-questions/transactions), so a transaction may still be declined by a miner.
- No mainnet coins were moved in this review. Unit tests use synthetic transactions and fake wallet responses; a live wallet and broadcast integration test remains necessary before relying on this with valuable funds.

## Verification performed

- `npm test`: 51 unit tests plus the three historical signing scripts passed. The historical signing script attempted a live fee lookup, then used its documented local fallback when sandbox DNS was unavailable.
- `npm run build`, `npm run lint`, and `git diff --check` passed.
- Adversarial tests cover altered destination outputs, added wallet inputs, zero outputs, excessive fee attempts, wrong destination identity, altered receipt fields, signature redirection, BRC-157 entropy boundaries, incomplete scans, and a deterministic 128-key fee-rounding sweep.

## Primary references

- [BRC-100 wallet interface](https://bsv.brc.dev/wallet/0100) (`createAction`, `getPublicKey`, `signAction`)
- [BRC-42 key derivation](https://bsv.brc.dev/key-derivation/0042) and [BRC-43 derivation identifiers](https://bsv.brc.dev/key-derivation/0043)
- [BRC-157 entropy-rooted backup](https://bsv.brc.dev/key-derivation/0157) and [BRC-75 mnemonic master key](https://bsv.brc.dev/key-derivation/0075)
- [BSV sighash flags](https://docs.bsvblockchain.org/important-concepts/details/sighash-flags)
- [Centbee recovery path documentation](https://github.com/HandCash/centbee-recovery#how-it-works)
- [Wallet Toolbox custom-output classification](https://raw.githubusercontent.com/bsv-blockchain/ts-stack/main/packages/wallet/wallet-toolbox/src/storage/methods/createAction.ts) and [wallet-managed balance](https://raw.githubusercontent.com/bsv-blockchain/ts-stack/main/packages/wallet/wallet-toolbox/src/Wallet.ts)
