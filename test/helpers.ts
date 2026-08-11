/**
 * Shared test helpers for AttestLine tests.
 *
 * Deploys the library stack with explicit linking (Hardhat does not auto-link
 * libraries), and installs the MockVerifier bytecode at the Block Prover
 * precompile address (0x…0FD2) via `hardhat_setCode` + `hardhat_setStorageAt`
 * so that AttestLine's real code path — calling the precompile address through
 * `NativeQueryVerifierLib.getVerifier()` — is exercised deterministically on the
 * local Hardhat network (no RPC, no secrets).
 */
import hre from "hardhat";
import { ZeroHash } from "ethers";
import { MockVerifier__factory, type AttestLine, type MockVerifier } from "../typechain-types";

export const BLOCK_PROVER_PRECOMPILE = "0x0000000000000000000000000000000000000FD2";

export interface MockConfig {
  chainKey?: number | bigint;
  height?: number | bigint;
  root?: string;
  /** When true, the mock enforces expectedChainKey/expectedHeight/root strictly. */
  enforce?: boolean;
  /** When true, every verification reverts (simulates a failing precompile). */
  fail?: boolean;
}

/** Deploy a library by fully-qualified name and return its address. */
export async function deployLibrary(fqn: string): Promise<string> {
  const factory = await hre.ethers.getContractFactory(fqn);
  const lib = await factory.deploy();
  await lib.waitForDeployment();
  return lib.target as string;
}

/**
 * Deploy AttestLine with the EvmV1Decoder and CreditScore libraries explicitly
 * linked. Optionally reuse a pre-deployed decoder address (e.g. the canonical
 * one on CC3 testnet).
 */
export async function deployAttestLine(termBlocks: number, decoderAddress?: string) {
  const libraries: Record<string, string> = {
    EvmV1Decoder:
      decoderAddress ??
      (await deployLibrary("@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol:EvmV1Decoder")),
    CreditScore: await deployLibrary("contracts/CreditScore.sol:CreditScore"),
  };
  const factory = await hre.ethers.getContractFactory("AttestLine", { libraries });
  const attestLine = await factory.deploy(termBlocks);
  await attestLine.waitForDeployment();
  return attestLine as unknown as AttestLine;
}

/**
 * Install the MockVerifier bytecode + configuration at the Block Prover
 * precompile address. Returns the (temporary) MockVerifier instance, which can
 * be used with `revertedWithCustomError` matchers.
 */
export async function installMockVerifier(config: MockConfig = {}): Promise<MockVerifier> {
  const [signer] = await hre.ethers.getSigners();
  const mock = await new MockVerifier__factory(signer).deploy();
  await mock.waitForDeployment();

  await mock.__configure(
    BigInt(config.chainKey ?? 1),
    BigInt(config.height ?? 0),
    config.root ?? ZeroHash,
    Boolean(config.enforce ?? false),
    Boolean(config.fail ?? false)
  );

  const snapshot = await mock.__configSnapshot();
  const code = await hre.ethers.provider.getCode(mock.target);

  await hre.network.provider.send("hardhat_setCode", [BLOCK_PROVER_PRECOMPILE, code]);
  for (let i = 0; i < snapshot.length; i++) {
    await hre.network.provider.send("hardhat_setStorageAt", [
      BLOCK_PROVER_PRECOMPILE,
      "0x" + i.toString(16).padStart(64, "0"),
      snapshot[i],
    ]);
  }

  return mock;
}

/** Mine `n` blocks on the local Hardhat network. */
export async function mineBlocks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await hre.network.provider.send("evm_mine");
  }
}
