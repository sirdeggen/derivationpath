# Derivation Path

**Recover BSV from a BIP-39 seed phrase.** Derivation Path scans common wallet derivation paths for spendable coins and moves selected coins to a backed-up, dated BRC-43 key verified through a [BRC-100](https://bsv.brc.dev/wallet/0100) wallet, or to a BSV address you provide. A dated key output may not appear in the wallet's ordinary balance; this app includes a separate recovery flow for it. Scans stop at the chosen gap and address limits, so a completed scan is not proof that every historical address was found. The tool runs in your browser.

It's built for wallets that no longer work or no longer exist, such as Centbee, RockWallet, MoneyButton and Twetch, where the coins are still on the blockchain but the app to spend them is gone.

> [!WARNING]
> Use at your own risk. This software is provided **as is**, without warranty, and the authors accept no liability for any loss. Read the [Terms of Use](TERMS.md) before using it.

## Contents

- [Why a derivation path matters](#why-a-derivation-path-matters)
- [Features](#features)
- [Run it locally](#run-it-locally)
- [How to recover your coins](#how-to-recover-your-coins)
- [Supported wallets](#supported-wallets)
- [Security and privacy](#security-and-privacy)
- [Development](#development)
- [Terms of Use and disclaimer](#terms-of-use-and-disclaimer)
- [License](#license)

## Why a derivation path matters

A seed phrase doesn't hold coins directly. Each wallet app follows its own recipe, a **derivation path** such as `m/44'/0'/0'/0/0`, to turn the phrase into a list of addresses. The same phrase gives completely different addresses under different paths, so an app that uses the wrong path shows an empty wallet even when the coins are there. Derivation Path knows the recipes of common BSV wallets and can try all of them.

## Features

| | |
| --- | --- |
| **Wallet** | Load a 12 to 24 word BIP39 phrase, with an optional PIN or passphrase, or generate a new one. Pick the wallet app it came from or type any path. |
| **Recover** | Walk receive and change addresses until a run of unused ones (the gap limit), on one path or every known wallet at once. Move what it finds to a backed-up dated key or any address; recover dated outputs with the documented key recipe. |
| **Send** | Pay from the selected address, or send everything on it. You review the transaction before it goes out. |
| **Tokens** | See 1Sat ordinals (NFTs) and BSV-20 tokens at an address. They are never spent by accident. |
| **History** | List past transactions across your addresses. |
| **Backup** | Save your phrase encrypted with a password (AES-GCM, PBKDF2-SHA256 with 310,000 iterations), in the browser or as a file. |
| **Settings** | Choose the blockchain data source, the transaction link and the network fee. |

The interface works on phones (bottom tab bar), has a light and dark theme, and explains every field in plain language.

## Run it locally

Running it on your own computer is the safest way to use it: you don't have to trust anyone hosting a copy. You need [Node.js](https://nodejs.org) 20 or later.

```bash
git clone https://github.com/vincemedia/derivationpath.git
cd derivationpath
npm install
npm run dev
```

Then open http://localhost:5173.

To serve a production build instead:

```bash
npm run build
npm run preview    # http://localhost:4173
```

## How to recover your coins

1. **Wallet tab:** choose the wallet app that created the phrase, type the phrase and its PIN or passphrase (leave it empty if you never set one), then press **Load wallet**.
2. **Recover tab:** press **Scan for coins**. Not sure which app you used? Pick **Every wallet we know** under "Paths to scan".
3. **Review:** the table lists funded addresses found within the scan limits. Untick any you want to leave.
4. **Move the coins:**
   - **Backed-up dated key:** open the receiving BRC-100 wallet and enter its backed-up seed phrase and any passphrase. Choose a UTC recovery date, then press **Prepare wallet transaction**. The tool verifies that the connected wallet's identity and receive key match the backup under BRC-157 or BRC-75, constructs one exact output to that key, and checks every input, signature, and final fee. Review the destination and amount, download the public recovery receipt, re-open that saved file to verify it, confirm your phrase is backed up, then send. This is a custom output and may not show in the wallet's ordinary balance.
   - **Any BSV address:** paste an address whose key or derivation path you have backed up, press **Prepare transaction**, check the exact destination and fee, then press **Send now**.
5. A link to the transaction appears. The results are cleared so the same coins can't be moved twice. To recover a dated output later, use the separate **Recover a dated output** section with its seed phrase, passphrase, root scheme, and receipt date.

Found nothing? Try **Every wallet we know**, raise the gap limit, or check your old wallet's documentation for its path and type it in.

## Supported wallets

A path template uses `{index}` for the address number and, optionally, `{chain}` for the list (0 = receive, 1 = change). `'` marks a hardened step.

| Wallet | Path template |
| --- | --- |
| Centbee | `m/44'/0/{chain}/{index}` |
| RockWallet | `m/0'/0/{index}` |
| BIP44 default, MoneyButton, Twetch | `m/44'/0'/0'/{chain}/{index}` |
| ElectrumSV, Exodus, RelayX, Keevo | `m/44'/236'/0'/{chain}/{index}` |
| Atomic, SimplyCash | `m/44'/145'/0'/{chain}/{index}` |
| BIP32 basic | `m/0'/{chain}'/{index}'` |
| Legacy prefixes from earlier versions of this tool | `m/44'/236'/0'/{index}`, `m/44'/0'/0'/{index}` |

Any other BIP32 path can be typed in as a custom template.

## Security and privacy

**Your keys stay in your browser.** The seed phrase, passphrase and private keys are never sent to any server and never saved unencrypted. Only public data leaves the page: addresses and signed transactions go to [WhatsOnChain](https://whatsonchain.com) for balances, history and broadcasting, and addresses go to [GorillaPool](https://ordinals.gorillapool.io) for the NFT and token check.

**Safety rails built in:**

- **NFTs and tokens are protected.** Before any spend, every coin is checked against GorillaPool's 1Sat indexer, including BSV-20 outputs, which the indexer only returns on request, and every page of results. Flagged coins and every 1-sat coin are left alone. If the check can't run, nothing is sent.
- **Coins are verified before signing.** Each input's source transaction is fetched and must be a plain payment of the expected amount to your address, so an inscription or a wrong amount from the API is refused.
- **Scans fail loudly.** Requests are rate-limited and retried; a scan that can't reach the network stops with an error instead of showing a partial result as complete.
- **Fees are sanity-checked**, and every irreversible action asks for confirmation.
- **Auto-lock.** Keys are wiped after 10 minutes without activity or 60 seconds in a background tab. With a saved backup you unlock with its password.

**Recovery destination scheme:** The backed-up dated-key flow uses [BRC-43](https://bsv.brc.dev/key-derivation/0043) self-derivation with security level `0`, protocol ID `derivation path recovery`, and key ID `YYYY-MM-DD` in UTC. The invoice number is `0-derivation path recovery-YYYY-MM-DD`. No random key ID, prefix, or suffix is needed. The public receipt records the date, protocol, root scheme, identity key, destination key, address, amount, fee, and transaction ID. Preserve the destination seed phrase and any passphrase offline; the receipt contains no secret. [BRC-157](https://bsv.brc.dev/key-derivation/0157) roots use `m/0'/0'`, while [BRC-75](https://bsv.brc.dev/key-derivation/0075) roots use SHA-256 of the BIP-39 seed. Wallets using a different mnemonic-to-identity scheme are refused in this flow. BSV Desktop's wallet toolbox treats caller-specified basket outputs as custom outputs, so do not rely on this payment appearing in its ordinary balance. Use this app's dated-output recovery flow or another implementation of the documented recipe to spend it.

**Fee target:** The default target is 100 sats per KB. Local sends, including spending a dated BRC-43 output, use a target from 90 to 110 sats per KB chosen in Settings; sending to a dated key targets 100. The final signed fee must be within 10 sats per KB of the selected target and within the overall 90–110 sats per KB band, with whole-satoshi rounding. There is no fixed absolute satoshi fee cap: larger transactions pay proportionally more. Miners may have different acceptance policies, so a transaction can still be refused.

Only enter seed phrases on a device you trust. Consider moving recovered coins to a fresh, separately backed-up wallet.

## Development

Built with React 19, TypeScript and Vite, on [`@bsv/sdk`](https://github.com/bsv-blockchain/ts-sdk).

```bash
npm run dev         # dev server on :5173
npm run build       # typecheck + production build
npm run lint
npm test            # vitest unit tests + signing scripts
npm run terms:md    # regenerate TERMS.md after editing src/terms.ts
```

| Folder | What's in it |
| --- | --- |
| `src/lib` | UI-free logic: derivation and presets, network clients, NFT/token protection, scanning, transaction building, the BRC-100 sweep and the encrypted vault |
| `src/components` | The panels and shared UI (popover selects, tooltips, explainers, tab bar) |
| `src/hooks` | Auto-lock, theme and task/status helpers |
| `public/wallets` | Wallet icons, bundled so nothing loads from third-party sites |

Unit tests cover derivation vectors, path parsing, NFT/token filtering, the vault and adversarial transaction building against mocked APIs and a wallet. [CLAUDE.md](CLAUDE.md) has architecture notes and the rules every spend must follow. The [current adversarial review](SECURITY_REVIEW_2026-09-30.md) documents what was checked and what remains unverified. Earlier `SECURITY_*.md` files are historical reviews of the original version.

## Terms of Use and disclaimer

By using Derivation Path you agree to the [Terms of Use](TERMS.md), which are also shown in the app (footer link, or `#terms`). They cover the no-warranty and no-liability terms, your responsibilities, a waiver of class and collective actions, and Dutch law as the governing law.

THIS SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, ACCURACY AND NON-INFRINGEMENT. YOU USE IT ENTIRELY AT YOUR OWN RISK. TO THE FULLEST EXTENT PERMITTED BY LAW, IN NO EVENT SHALL THE AUTHORS, CONTRIBUTORS, COPYRIGHT HOLDERS OR ANYONE HOSTING THIS SOFTWARE BE LIABLE FOR ANY CLAIM, LOSS OF FUNDS OR DIGITAL ASSETS, LOSS OF DATA, OR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL OR OTHER DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT (INCLUDING NEGLIGENCE) OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR ITS USE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES. NOTHING HERE IS FINANCIAL, LEGAL OR TAX ADVICE. BLOCKCHAIN TRANSACTIONS ARE IRREVERSIBLE, AND NO ONE CAN RECOVER FUNDS SENT TO THE WRONG ADDRESS OR A LOST SEED PHRASE, PASSPHRASE OR PASSWORD.

## License

[Apache License 2.0](LICENSE.txt).
