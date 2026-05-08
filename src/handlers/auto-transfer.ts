import { ethers } from "ethers";
import { PermitReward, TokenType } from "../types";
import { Context } from "../types/context";
import { decrypt, parseDecryptedPrivateKey } from "../utils";
import { getRpcProvider } from "../utils/get-fastest-provider";

// Minimal ERC20 ABI for transfer and decimals
const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
];

// Default gas limit estimate for ERC20 transfer
const ERC20_TRANSFER_GAS_LIMIT = 65000;

export interface TransferResult {
  beneficiary: string;
  tokenAddress: string;
  amount: string;
  txHash: string | null;
  networkId: number;
  operatorFee: string;
  gasEstimate: GasEstimate;
  status: "success" | "skipped" | "failed";
  error?: string;
}

export interface GasEstimate {
  gasLimit: number;
  gasPrice: string; // in wei
  estimatedCost: string; // in native token (wei)
  networkId: number;
}

/**
 * Estimates gas fees for an ERC20 transfer on the given network.
 * Dynamically fetches current gas price from the provider.
 */
export async function estimateGas(
  provider: ethers.providers.JsonRpcProvider,
  fromAddress: string,
  toAddress: string,
  tokenAddress: string,
  amount: string
): Promise<GasEstimate> {
  const network = await provider.getNetwork();

  // Get current fee data (supports EIP-1559 and legacy)
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice || feeData.maxFeePerGas || ethers.BigNumber.from("20000000000"); // 20 gwei fallback

  const erc20 = new ethers.Contract(tokenAddress, ERC20_ABI, provider);

  // Try to estimate gas for the actual transfer
  let gasLimit: number;
  try {
    const estimated = await erc20.estimateGas.transfer(toAddress, amount, { from: fromAddress });
    // Add 20% buffer
    gasLimit = Math.ceil(estimated.toNumber() * 1.2);
  } catch {
    // Fallback to default estimate
    gasLimit = ERC20_TRANSFER_GAS_LIMIT;
  }

  const estimatedCost = ethers.BigNumber.from(gasLimit).mul(gasPrice);

  return {
    gasLimit,
    gasPrice: gasPrice.toString(),
    estimatedCost: estimatedCost.toString(),
    networkId: network.chainId,
  };
}

/**
 * Executes automatic transfers for generated permits.
 * Only processes ERC20 permits with `transfer: true` in config.
 */
export async function executeAutoTransfers(context: Context, permits: PermitReward[]): Promise<TransferResult[]> {
  const { config } = context;
  const results: TransferResult[] = [];

  // Skip if transfer is not enabled
  if (!config.transfer) {
    context.logger.info("Auto-transfer is not enabled, skipping.");
    return results;
  }

  const operatorFeePercent = config.operatorFeePercent ?? 0;
  if (operatorFeePercent < 0 || operatorFeePercent > 100) {
    throw new Error(`Invalid operatorFeePercent: ${operatorFeePercent}. Must be between 0 and 100.`);
  }

  // Get admin wallet — wrap setup in try/catch to return failed results instead of throwing
  let provider: ethers.providers.JsonRpcProvider;
  try {
    provider = await getRpcProvider(config.evmNetworkId);
    if (!provider) {
      return permits.map(permit => ({
        beneficiary: permit.beneficiary,
        tokenAddress: permit.tokenAddress,
        amount: permit.amount.toString(),
        txHash: null,
        networkId: permit.networkId,
        operatorFee: "0",
        gasEstimate: { gasLimit: 0, gasPrice: "0", estimatedCost: "0", networkId: permit.networkId },
        status: "failed" as const,
        error: "Failed to get RPC provider for auto-transfer",
      }));
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return permits.map(permit => ({
      beneficiary: permit.beneficiary,
      tokenAddress: permit.tokenAddress,
      amount: permit.amount.toString(),
      txHash: null,
      networkId: permit.networkId,
      operatorFee: "0",
      gasEstimate: { gasLimit: 0, gasPrice: "0", estimatedCost: "0", networkId: permit.networkId },
      status: "failed" as const,
      error: `Provider setup failed: ${msg}`,
    }));
  }

  let adminWallet: ethers.Wallet;
  try {
    const privateKeyDecrypted = await decrypt(config.evmPrivateEncrypted, String(process.env.X25519_PRIVATE_KEY));
    const privateKeyParsed = parseDecryptedPrivateKey(privateKeyDecrypted);
    const privateKey = privateKeyParsed.privateKey;
    if (!privateKey) {
      return permits.map(permit => ({
        beneficiary: permit.beneficiary,
        tokenAddress: permit.tokenAddress,
        amount: permit.amount.toString(),
        txHash: null,
        networkId: permit.networkId,
        operatorFee: "0",
        gasEstimate: { gasLimit: 0, gasPrice: "0", estimatedCost: "0", networkId: permit.networkId },
        status: "failed" as const,
        error: "Private key is not defined for auto-transfer",
      }));
    }
    adminWallet = new ethers.Wallet(privateKey, provider);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return permits.map(permit => ({
      beneficiary: permit.beneficiary,
      tokenAddress: permit.tokenAddress,
      amount: permit.amount.toString(),
      txHash: null,
      networkId: permit.networkId,
      operatorFee: "0",
      gasEstimate: { gasLimit: 0, gasPrice: "0", estimatedCost: "0", networkId: permit.networkId },
      status: "failed" as const,
      error: `Key setup failed: ${msg}`,
    }));
  }

  for (const permit of permits) {
    // Network consistency guard — each permit carries its own networkId,
    // but execution network comes from config. Reject mismatch early to
    // avoid signing on the wrong chain.
    if (permit.networkId !== config.evmNetworkId) {
      results.push({
        beneficiary: permit.beneficiary,
        tokenAddress: permit.tokenAddress,
        amount: permit.amount?.toString() ?? "0",
        txHash: null,
        networkId: permit.networkId,
        operatorFee: "0",
        gasEstimate: { gasLimit: 0, gasPrice: "0", estimatedCost: "0", networkId: permit.networkId },
        status: "skipped",
        error: `Network mismatch: permit is on ${permit.networkId}, config expects ${config.evmNetworkId}`,
      });
      continue;
    }

    // Only auto-transfer ERC20 tokens
    if (permit.tokenType !== TokenType.ERC20) {
      results.push({
        beneficiary: permit.beneficiary,
        tokenAddress: permit.tokenAddress,
        amount: permit.amount?.toString() ?? "0",
        txHash: null,
        networkId: permit.networkId,
        operatorFee: "0",
        gasEstimate: {
          gasLimit: 0,
          gasPrice: "0",
          estimatedCost: "0",
          networkId: permit.networkId,
        },
        status: "skipped",
        error: "Non-ERC20 permit, auto-transfer skipped",
      });
      continue;
    }

    try {
      const erc20 = new ethers.Contract(permit.tokenAddress, ERC20_ABI, adminWallet);

      // Calculate amounts — use optional chaining because ERC721 permits
      // may omit the amount field entirely.
      const rawAmount = permit.amount ?? 0;
      const totalAmount = ethers.BigNumber.from(rawAmount);
      const operatorFee = totalAmount.mul(Math.round(operatorFeePercent * 100)).div(10000);
      const beneficiaryAmount = totalAmount.sub(operatorFee);

      // Handle zero-amount beneficiary transfer (fee is 100%) — some ERC20
      // tokens revert on zero-value transfers, so we skip to avoid wasting gas.
      if (beneficiaryAmount.isZero()) {
        results.push({
          beneficiary: permit.beneficiary,
          tokenAddress: permit.tokenAddress,
          amount: "0",
          txHash: null,
          networkId: permit.networkId,
          operatorFee: operatorFee.toString(),
          gasEstimate: { gasLimit: 0, gasPrice: "0", estimatedCost: "0", networkId: permit.networkId },
          status: "skipped",
          error: "Beneficiary amount is zero after operator fee",
        });
        continue;
      }

      // Estimate gas
      const gasEstimate = await estimateGas(provider, adminWallet.address, permit.beneficiary, permit.tokenAddress, beneficiaryAmount.toString());

      let tokenDecimals: number;
      try {
        tokenDecimals = await erc20.decimals();
      } catch {
        tokenDecimals = 18; // fallback for tokens without decimals()
        context.logger.warn(`Token ${permit.tokenAddress} does not implement decimals(), using default 18`);
      }
      context.logger.info(
        `Auto-transfer: ${ethers.utils.formatUnits(beneficiaryAmount, tokenDecimals)} tokens to ${permit.beneficiary}, ` +
          `operator fee: ${ethers.utils.formatUnits(operatorFee, tokenDecimals)}, ` +
          `estimated gas: ${ethers.utils.formatEther(gasEstimate.estimatedCost)} native token`
      );

      // Transfer to beneficiary
      const transferTx = await erc20.transfer(permit.beneficiary, beneficiaryAmount, {
        gasLimit: gasEstimate.gasLimit,
      });

      context.logger.info(`Transfer tx submitted: ${transferTx.hash}`);

      // Wait for confirmation
      await transferTx.wait();

      results.push({
        beneficiary: permit.beneficiary,
        tokenAddress: permit.tokenAddress,
        amount: beneficiaryAmount.toString(),
        txHash: transferTx.hash,
        networkId: permit.networkId,
        operatorFee: operatorFee.toString(),
        gasEstimate,
        status: "success",
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      context.logger.error(`Auto-transfer failed for ${permit.beneficiary}: ${errorMessage}`);
      results.push({
        beneficiary: permit.beneficiary,
        tokenAddress: permit.tokenAddress,
        amount: permit.amount?.toString() ?? "0",
        txHash: null,
        networkId: permit.networkId,
        operatorFee: "0",
        gasEstimate: {
          gasLimit: 0,
          gasPrice: "0",
          estimatedCost: "0",
          networkId: permit.networkId,
        },
        status: "failed",
        error: errorMessage,
      });
    }
  }

  return results;
}
