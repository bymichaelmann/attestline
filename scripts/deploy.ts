/**
 * deploy.ts — network-aware deployment of the AttestLine stack.
 *
 * Default target: CC3 testnet (`npx hardhat run scripts/deploy.ts --network cc3`).
 *
 * Deploys, in order:
 *   1. EvmV1Decoder library (or reuses DECODER_ADDRESS if set)
 *   2. CreditScore library
 *   3. AttestLine ASC (libraries linked)
 *   4. LineToken (minter = AttestLine) and registers it on AttestLine
 *   5. Registers the source-chain CreditActivity contract (either a previously
 *      deployed address via SOURCE_CHAIN_ACTIVITY_CONTRACT, or deploys a new
 *      one on the source chain when SOURCE_CHAIN_RPC_URL +
 *      SOURCE_CHAIN_WALLET_KEY are configured)
 *
 * Outputs the deployed addresses and a ready-to-paste .env block. Private keys
 * are never printed.
 */
import "dotenv/config";
import hre from "hardhat";
import { JsonRpcProvider, Wallet, ContractFactory } from "ethers";
import { loadConfig } from "../src/config";

async function main() {
  const cfg = loadConfig();
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) {
    throw new Error("No signer available — set PRIVATE_KEY in .env for network deploys");
  }

  const network = hre.network.name;
  const chainId = (await hre.ethers.provider.getNetwork()).chainId;
  console.log(`\nDeploying AttestLine stack to network "${network}" (chainId ${chainId})`);
  console.log(`Deployer: ${deployer.address}\n`);

  // ── 1. Libraries ───────────────────────────────────────────────────────────
  let decoderAddress = cfg.decoderAddress;
  if (!decoderAddress) {
    console.log("Deploying EvmV1Decoder library...");
    const decoder = await (
      await hre.ethers.getContractFactory(
        "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol:EvmV1Decoder"
      )
    ).deploy();
    await decoder.waitForDeployment();
    decoderAddress = decoder.target as string;
  }
  console.log(`EvmV1Decoder: ${decoderAddress}`);

  console.log("Deploying CreditScore library...");
  const creditScore = await (
    await hre.ethers.getContractFactory("contracts/CreditScore.sol:CreditScore")
  ).deploy();
  await creditScore.waitForDeployment();
  const creditScoreAddress = creditScore.target as string;
  console.log(`CreditScore:  ${creditScoreAddress}`);

  // ── 2. AttestLine ASC ──────────────────────────────────────────────────────
  console.log(`Deploying AttestLine (termBlocks=${cfg.termBlocks})...`);
  const attestLine = await (
    await hre.ethers.getContractFactory("AttestLine", {
      libraries: {
        EvmV1Decoder: decoderAddress,
        CreditScore: creditScoreAddress,
      },
    })
  ).deploy(cfg.termBlocks);
  await attestLine.waitForDeployment();
  const attestLineAddress = attestLine.target as string;
  console.log(`AttestLine:    ${attestLineAddress}`);

  // ── 3. LineToken ───────────────────────────────────────────────────────────
  console.log("Deploying LineToken (minter = AttestLine)...");
  const lineToken = await (await hre.ethers.getContractFactory("LineToken")).deploy(
    attestLineAddress
  );
  await lineToken.waitForDeployment();
  const lineTokenAddress = lineToken.target as string;
  console.log(`LineToken:     ${lineTokenAddress}`);

  console.log("Registering LineToken on AttestLine...");
  await (await attestLine.setLineToken(lineTokenAddress)).wait();

  // ── 4. Source-chain CreditActivity ─────────────────────────────────────────
  let sourceContractAddress = cfg.sourceContractAddress;
  if (sourceContractAddress) {
    console.log(`Using existing source contract: ${sourceContractAddress}`);
  } else if (cfg.sourceChainRpcUrl && cfg.sourceChainWalletKey) {
    console.log(`Deploying CreditActivity on the source chain (${cfg.sourceChainRpcUrl})...`);
    const sourceProvider = new JsonRpcProvider(cfg.sourceChainRpcUrl);
    const sourceWallet = new Wallet(cfg.sourceChainWalletKey, sourceProvider);
    const artifact = await hre.artifacts.readArtifact("CreditActivity");
    const factory = new ContractFactory(artifact.abi, artifact.bytecode, sourceWallet);
    const activity = await factory.deploy();
    await activity.waitForDeployment();
    sourceContractAddress = activity.target as string;
    console.log(`CreditActivity (source chain): ${sourceContractAddress}`);
  } else {
    console.warn(
      "No source contract configured. Deploy CreditActivity on the source chain and call\n" +
        "  attestLine.setSourceContract(<address>) as the owner (or set SOURCE_CHAIN_ACTIVITY_CONTRACT)."
    );
  }

  if (sourceContractAddress) {
    console.log("Registering source contract on AttestLine...");
    await (await attestLine.setSourceContract(sourceContractAddress)).wait();
  }

  // ── 5. Summary ─────────────────────────────────────────────────────────────
  console.log("\n✅ Deployment complete.");
  console.log("\nAdd to .env (or export):\n");
  console.log(`ATTESTLINE_CONTRACT=${attestLineAddress}`);
  console.log(`LINE_TOKEN_CONTRACT=${lineTokenAddress}`);
  console.log(`DECODER_ADDRESS=${decoderAddress}`);
  if (sourceContractAddress) {
    console.log(`SOURCE_CHAIN_ACTIVITY_CONTRACT=${sourceContractAddress}`);
  }
  console.log(`CHAIN_KEY=${cfg.chainKey}`);
  console.log("");

  if (sourceContractAddress) {
    const attestLineContract = await hre.ethers.getContractAt(
      "AttestLine",
      attestLineAddress,
      deployer
    );
    console.log(`Registered sourceContract: ${await attestLineContract.sourceContract()}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
