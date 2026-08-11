# Deploying AttestLine on the CC3 testnet

Step-by-step guide to deploying AttestLine on the Creditcoin CC3 testnet and running the live
demo/worker.

## 0. Prerequisites

- Node.js 20+ and npm.
- An account funded with test CTC on CC3 testnet (faucet — see the Creditcoin docs,
  docs.creditcoin.org).
- An Ethereum Sepolia account funded with test ETH (for recording activity on the source chain).
- A running proof builder service for CC3 (public default:
  `https://prover.cc3-testnet.creditcoin.network`).

## 1. Install & configure

```bash
git clone https://github.com/bymichaelmann/attestline.git
cd attestline
npm ci
npx hardhat compile
cp .env.example .env
```

Edit `.env`:

| Variable | Value |
| --- | --- |
| `CREDITCOIN_RPC_URL` | `https://rpc.cc3-testnet.creditcoin.network` (default) |
| `SOURCE_CHAIN_RPC_URL` | a public Sepolia RPC, e.g. `https://ethereum-sepolia-rpc.publicnode.com` |
| `CHAIN_KEY` | `1` (Ethereum Sepolia) |
| `PRIVATE_KEY` | your Creditcoin testnet account key (funded with test CTC) |
| `SOURCE_CHAIN_WALLET_KEY` | your Sepolia account key (funded with test ETH) |
| `PROOF_BUILDER_URL` | `https://prover.cc3-testnet.creditcoin.network` (default) |
| `DECODER_ADDRESS` | `0x731c345d79Fb8BbDC541f9DF3b6317585F849F9f` — pre-deployed EvmV1Decoder on CC3 (deploy reuses it; unset to deploy your own) |

> Never commit `.env` — it is gitignored. All keys are placeholders in `.env.example`.

## 2. Deploy

```bash
npx hardhat run scripts/deploy.ts --network cc3
```

The script deploys (or reuses) the EvmV1Decoder library, deploys the CreditScore library, the
AttestLine ASC, the LineToken, registers the LineToken, and — if
`SOURCE_CHAIN_WALLET_KEY` is set — deploys the `CreditActivity` contract on Sepolia and registers
it as the source contract. It prints an env block to paste back into `.env`:

```
ATTESTLINE_CONTRACT=0x…
LINE_TOKEN_CONTRACT=0x…
DECODER_ADDRESS=0x731c345d79Fb8BbDC541f9DF3b6317585F849F9f
SOURCE_CHAIN_ACTIVITY_CONTRACT=0x…
```

If you deploy `CreditActivity` separately (e.g. with Foundry), set
`SOURCE_CHAIN_ACTIVITY_CONTRACT` before running deploy, or call
`attestLine.setSourceContract(<address>)` as the owner afterwards.

## 3. Run the live demo

The demo records activity on Sepolia, waits for attestation (typically a few minutes), requests a
credit line, draws, and repays:

```bash
export ENABLE_LIVE_DEMO=1
npm run demo            # = hardhat run scripts/demo.ts --network cc3
```

`DEMO_AMOUNT` (in whole ALCT-denominated units, default `8`) controls how much activity is
recorded.

## 4. Run the readability worker

The worker polls `CreditActivityRecorded` events on the source chain and submits proofs as they
become attestable:

```bash
export ENABLE_WORKER=1
export WORKER_PRIVATE_KEYS=0x…,0x…   # keys of the borrower accounts to underwrite
npm run worker           # = hardhat run scripts/worker.ts --network cc3
```

Because AttestLine requires the attested account to equal `msg.sender`, the worker can only
underwrite accounts whose keys are listed in `WORKER_PRIVATE_KEYS`. Events from other accounts are
logged and skipped. Set `WORKER_START_BLOCK` to start from a specific block (default: latest).

## 5. Verifying a deployment

```bash
# Source contract registered?
curl -s -X POST https://rpc.cc3-testnet.creditcoin.network \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"<ATTESTLINE>","data":"<sourceContract() selector>"},"latest"],"id":1}'

# Supported chains (ChainInfo precompile 0x…0FD3)
curl -s -X POST https://rpc.cc3-testnet.creditcoin.network \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"0x0000000000000000000000000000000000000FD3","data":"<selector>"},"latest"],"id":1}'
```

## 6. Notes & gotchas

- **Attestation takes minutes.** `waitUntilHeightAttested` polls the proof builder (default 15 s
  interval, 15 min timeout). Sepolia blocks are attested in batches; ~8 minutes is typical.
- **Gas estimation on precompile calls** can fail in estimation mode (a known pallet-evm quirk);
  the official examples fall back to a size-based estimate. AttestLine submits a plain call to the
  precompile — if your wallet under-estimates, bump the gas limit manually.
- **The decoder address** `0x731c345d79Fb8BbDC541f9DF3b6317585F849F9f` is the pre-deployed
  EvmV1Decoder on CC3 testnet (verified to hold contract code). If it is ever unavailable, deploy
  your own by unsetting `DECODER_ADDRESS` — the deploy script will deploy and link a fresh one.
- **Chain ID** of CC3 testnet is `101519` (`0x18e8f`).
