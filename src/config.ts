/**
 * AttestLine configuration loader.
 *
 * Reads environment variables with sane defaults for the CC3 testnet and
 * validates them. NEVER logs private keys or secrets.
 */

export const DEFAULT_CREDITCOIN_RPC_URL = "https://rpc.cc3-testnet.creditcoin.network";
export const DEFAULT_PROOF_BUILDER_URL = "https://prover.cc3-testnet.creditcoin.network";
export const DEFAULT_SOURCE_CHAIN_RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
export const DEFAULT_CHAIN_KEY = 1; // 1 = Ethereum Sepolia on Creditcoin
export const DEFAULT_DECODER_ADDRESS = "0x731c345d79Fb8BbDC541f9DF3b6317585F849F9f";
export const DEFAULT_TERM_BLOCKS = 648_000; // ≈ 90 days at 12s blocks

export interface AttestLineConfig {
  creditcoinRpcUrl: string;
  sourceChainRpcUrl: string;
  proofBuilderUrl: string;
  chainKey: number;
  /** Deployed AttestLine address on Creditcoin (required by client/worker/demo). */
  attestLineAddress?: string;
  /** Deployed LineToken address on Creditcoin (required by client/worker/demo). */
  lineTokenAddress?: string;
  /** Deployed CreditActivity address on the source chain. */
  sourceContractAddress?: string;
  /** Pre-deployed EvmV1Decoder library address (used by deploy). */
  decoderAddress?: string;
  /** Term of credit lines in blocks (used by deploy). */
  termBlocks: number;
  /** Creditcoin account private key (deploy/submit proofs). */
  privateKey?: string;
  /** Source-chain account private key (record activity). */
  sourceChainWalletKey?: string;
  /** Worker: start polling from this block (defaults to latest). */
  workerStartBlock?: number;
  /** Worker: keys the worker may submit proofs with. */
  workerPrivateKeys: string[];
}

export function isHttpUrl(value: string | undefined): value is string {
  return typeof value === "string" && /^https?:\/\/.+/.test(value);
}

export function isValidPrivateKey(value: string | undefined): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

export function isValidAddress(value: string | undefined): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function parseChainKey(value: string | undefined): number {
  const parsed = Number(value);
  if (value === undefined || Number.isNaN(parsed) || parsed < 0) {
    return DEFAULT_CHAIN_KEY;
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AttestLineConfig {
  const creditcoinRpcUrl = env.CREDITCOIN_RPC_URL ?? DEFAULT_CREDITCOIN_RPC_URL;
  const sourceChainRpcUrl = env.SOURCE_CHAIN_RPC_URL ?? DEFAULT_SOURCE_CHAIN_RPC_URL;
  const proofBuilderUrl = env.PROOF_BUILDER_URL ?? DEFAULT_PROOF_BUILDER_URL;
  const chainKey = parseChainKey(env.CHAIN_KEY);
  const termBlocks = Number(env.TERM_BLOCKS ?? DEFAULT_TERM_BLOCKS);

  const privateKey = env.PRIVATE_KEY || undefined;
  const sourceChainWalletKey = env.SOURCE_CHAIN_WALLET_KEY || undefined;
  const decoderAddress = env.DECODER_ADDRESS || undefined;

  const attestLineAddress = env.ATTESTLINE_CONTRACT || undefined;
  const lineTokenAddress = env.LINE_TOKEN_CONTRACT || undefined;
  const sourceContractAddress = env.SOURCE_CHAIN_ACTIVITY_CONTRACT || undefined;

  const workerStartBlock = env.WORKER_START_BLOCK
    ? Number(env.WORKER_START_BLOCK)
    : undefined;
  const workerPrivateKeys = (env.WORKER_PRIVATE_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);

  // ── Validation ─────────────────────────────────────────────────────────────
  if (!isHttpUrl(creditcoinRpcUrl)) {
    throw new Error(`CREDITCOIN_RPC_URL is not a valid http(s) URL: ${creditcoinRpcUrl}`);
  }
  if (!isHttpUrl(sourceChainRpcUrl)) {
    throw new Error(`SOURCE_CHAIN_RPC_URL is not a valid http(s) URL: ${sourceChainRpcUrl}`);
  }
  if (!isHttpUrl(proofBuilderUrl)) {
    throw new Error(`PROOF_BUILDER_URL is not a valid http(s) URL: ${proofBuilderUrl}`);
  }
  if (privateKey && !isValidPrivateKey(privateKey)) {
    throw new Error("PRIVATE_KEY must be a 0x-prefixed 64-character hex string");
  }
  if (sourceChainWalletKey && !isValidPrivateKey(sourceChainWalletKey)) {
    throw new Error("SOURCE_CHAIN_WALLET_KEY must be a 0x-prefixed 64-character hex string");
  }
  for (const [name, value] of [
    ["ATTESTLINE_CONTRACT", attestLineAddress],
    ["LINE_TOKEN_CONTRACT", lineTokenAddress],
    ["SOURCE_CHAIN_ACTIVITY_CONTRACT", sourceContractAddress],
    ["DECODER_ADDRESS", decoderAddress],
  ] as const) {
    if (value && !isValidAddress(value)) {
      throw new Error(`${name} must be a 0x-prefixed 40-character hex address`);
    }
  }
  for (const key of workerPrivateKeys) {
    if (!isValidPrivateKey(key)) {
      throw new Error("WORKER_PRIVATE_KEYS contains an invalid private key");
    }
  }
  if (!Number.isInteger(termBlocks) || termBlocks <= 0) {
    throw new Error("TERM_BLOCKS must be a positive integer");
  }

  return {
    creditcoinRpcUrl,
    sourceChainRpcUrl,
    proofBuilderUrl,
    chainKey,
    attestLineAddress,
    lineTokenAddress,
    sourceContractAddress,
    decoderAddress,
    termBlocks,
    privateKey,
    sourceChainWalletKey,
    workerStartBlock,
    workerPrivateKeys,
  };
}
