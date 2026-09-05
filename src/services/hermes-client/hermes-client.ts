/**
 * Hermes Client for fetching Pyth price data
 *
 * This client fetches AKT/USD price data from Pyth's Hermes API
 * and submits it to the Akash Pyth contract.
 *
 * The Pyth contract:
 * 1. Receives the VAA (Verified Action Approval) from this client
 * 2. Verifies VAA signatures via the pyth_vaa contract
 * 3. Parses Pyth price attestation from VAA payload
 * 4. Relays validated price to x/oracle module
 */

import { latestValue } from "../../lib/generators/latest-value/latest-value.ts";
import { blockchainPriceStaleness, priceUpdateCounter } from "../../metrics.ts";
import { ContractClientService, type ConfigResponse, type PriceResponse, type SigningClientServiceConfig } from "../contract-client/contract-client.service.ts";
import type { RouterSetUpdater } from "../router-set-updater/router-set-updater.ts";
import type { Logger, PriceProducerFactory, PriceUpdate, PythPriceData } from "../../types.ts";
import {
  sanitizeErrorMessage,
  validateContractAddress,
  validateEndpointUrl,
  validateWalletSecret,
} from "../../validation.ts";

export interface HermesConfig {
  /**
   * Allows insecure endpoint URLs (HTTP, private/internal addresses).
   * @default false
   */
  unsafeAllowInsecureEndpoints?: boolean;
  rpcEndpoint: string;
  contractAddress: string;
  walletSecret: SigningClientServiceConfig["walletSecret"];
  priceUpdateTxMethod: "ordered" | "unordered";
  denom: string;
  gasPrice: string;
  gasMultiplier: number;
  smartContractConfigCacheTTLMs: number;
  unorderedTxTtlMs: number;
  /**
   * Optional threshold for skipping updates when the price change is below a tolerance.
   * When omitted, no deviation filtering is applied and every price with a newer
   * publish time is submitted, even if the value is unchanged.
   *
   * - For `type: "absolute"`, `value` is an absolute price difference in quote currency units
   *   (e.g. `0.5` means $0.50 if the quote currency is USD).
   * - For `type: "percentage"`, `value` is a number from 0 to 100
   *   (e.g. `10` = 10%, `0.1` = 0.1%).
   */
  priceDeviationTolerance?: {
    type: "absolute" | "percentage";
    value: number;
  };

  /**
   * Factory function to create a price producer (AsyncGenerator) that yields price updates.
   * This allows for different implementations of price fetching logic (e.g. polling, SSE).
   */
  priceProducerFactory: PriceProducerFactory;

  /**
   * Optional logger for informational messages. Should implement log, error, and warn methods.
   */
  logger?: Logger;
  /**
   * Delay in milliseconds between submission retries when insufficient balance is detected.
   * @default 60000
   */
  insufficientBalanceRetryDelayMs?: number;
  /**
   * Creates the client used to talk to the chain. Defaults to a real {@link ContractClientService},
   * which opens an RPC connection; inject a fake to drive the client without a chain.
   */
  contractClientFactory?: (config: SigningClientServiceConfig) => ContractClient;
  routerSetUpdater?: Pick<RouterSetUpdater, "buildUpgradeVaa">;
}

/**
 * The chain access this client depends on. A subset of {@link ContractClientService}.
 */
export type ContractClient = Pick<ContractClientService, "getAccount" | "queryConfig" | "queryCurrentPrice" | "queryPythVaaConfig" | "submitRouterSetUpgrade" | "updatePrice" | "disconnect">;

export class HermesClient {
  readonly #signingClient: ContractClient;
  readonly #config: HermesConfig & Required<Pick<HermesConfig, "insufficientBalanceRetryDelayMs">>;
  #isRunning = false;
  #insufficientBalanceCooldownUntil: number | null = null;
  #lastPriceReceivedAt?: string;
  #lastPriceUpdateAt?: string;
  #logger: Exclude<HermesConfig["logger"], undefined>;

  constructor(config: HermesConfig) {
    const unsafeAllowInsecureEndpoints = config.unsafeAllowInsecureEndpoints ?? false;

    validateEndpointUrl(config.rpcEndpoint, "RPC endpoint", !unsafeAllowInsecureEndpoints);
    validateWalletSecret(config.walletSecret);
    validateContractAddress(config.contractAddress);

    this.#config = {
      ...config,
      insufficientBalanceRetryDelayMs: config.insufficientBalanceRetryDelayMs ?? 60_000,
    };
    this.#logger = config.logger ?? console;
    const createContractClient = config.contractClientFactory ?? (contractClientConfig => new ContractClientService(contractClientConfig));
    this.#signingClient = createContractClient({
      rpcEndpoint: config.rpcEndpoint,
      walletSecret: config.walletSecret,
      contractAddress: config.contractAddress,
      denom: config.denom,
      gasPrice: config.gasPrice,
      gasMultiplier: config.gasMultiplier,
      priceUpdateTxMethod: config.priceUpdateTxMethod,
      unorderedTxTtlMs: config.unorderedTxTtlMs,
      smartContractConfigCacheTTLMs: config.smartContractConfigCacheTTLMs,
    });
  }

  async #initialize(): Promise<void> {
    try {
      this.#logger.log("Initializing Hermes client...");

      const account = await this.#signingClient.getAccount();
      this.#logger.log(`Using address: ${account.address}`);

      this.#logger.log("Fetching smart contract configuration...");
      const smartContractConfig = await this.#signingClient.queryConfig();
      this.#logger.log(`Using Pyth Price Feed ID: ${smartContractConfig.price_feed_id}`);
      this.#logger.log(`Update fee: ${smartContractConfig.update_fee} ${this.#config.denom}`);

      this.#logger.log("Hermes client initialized successfully");
    } catch (error) {
      // SEC-04: Sanitize error messages to prevent information leakage
      const safeMessage = sanitizeErrorMessage(error, "Failed to initialize Hermes client");
      this.#logger.error(safeMessage);
      throw new Error(safeMessage);
    }
  }

  async updatePrice(options?: {
    signal?: AbortSignal;
  }): Promise<void> {
    const smartCotractConfig = await this.#signingClient.queryConfig();
    const priceStream = this.#config.priceProducerFactory({
      priceFeedId: smartCotractConfig.price_feed_id,
      logger: this.#logger,
      signal: options?.signal,
    });
    const priceUpdate = await priceStream.next();

    if (priceUpdate.value) {
      await this.#updatePrice(priceUpdate.value);
      this.#logger.log("\nUpdate completed successfully!");
    } else {
      this.#logger.log("\nUpdate skipped because no new price was available.");
    }

    priceStream.return?.();
  }

  /**
     * Update the oracle contract with new price data
     *
     * Flow:
     * 1. Fetch price + VAA from Pyth Hermes API
     * 2. Check if price is newer than current (optimization)
     * 3. Send VAA to Pyth contract
     * 4. Contract verifies VAA via Wormhole, parses Pyth payload, relays to x/oracle
     */
  async #updatePrice(priceUpdate: PriceUpdate): Promise<void> {
    if (this.#insufficientBalanceCooldownUntil !== null) {
      if (Date.now() < this.#insufficientBalanceCooldownUntil) {
        this.#logger.warn("Skipping price update: insufficient balance cooldown active");
        return;
      }
      this.#logger.log("Insufficient balance cooldown expired, retrying...");
    }

    const startTime = performance.now();

    try {
      const currentPrice = await this.#signingClient.queryCurrentPrice();

      const staleness = priceUpdate.priceData.price.publish_time - currentPrice.publish_time;
      blockchainPriceStaleness.record(staleness);

      if (this.#canIgnorePriceUpdate(priceUpdate.priceData, currentPrice)) {
        priceUpdateCounter.add(1, { result: "skipped" });
        return;
      }

      const config = await this.#signingClient.queryConfig();

      const result = await this.#submitPriceUpdate(priceUpdate, config);

      const price = priceUpdate.priceData.price;
      this.#logger.log(`Price updated successfully! TX: ${result.transactionHash}`);
      if (result.gasUsed !== undefined) {
        this.#logger.log(`  Gas used: ${result.gasUsed}`);
      }
      this.#logger.log(`  New price: ${price.price} (expo: ${price.expo})`);
      priceUpdateCounter.add(1, { result: "success" });
      this.#lastPriceUpdateAt = new Date().toISOString();
      this.#insufficientBalanceCooldownUntil = null;
    } catch (error) {
      // SEC-04: Sanitize error messages to prevent information leakage
      const errorCode = classifyError(error);
      if (errorCode === "insufficient_balance") {
        this.#insufficientBalanceCooldownUntil = Date.now() + this.#config.insufficientBalanceRetryDelayMs;
        this.#logger.warn(`Entering insufficient balance cooldown for ${this.#config.insufficientBalanceRetryDelayMs}ms`);
      }
      const safeMessage = sanitizeErrorMessage(error, "Failed to update price");
      this.#logger.error(safeMessage);
      priceUpdateCounter.add(1, { result: "failure", error_code: errorCode });
      throw new Error(safeMessage);
    } finally {
      this.#logger.log(`Price updated in ${((performance.now() - startTime) / 1000).toFixed(2)} s`);
    }
  }

  async #submitPriceUpdate(priceUpdate: PriceUpdate, config: ConfigResponse): Promise<{
    transactionHash: string;
    gasUsed?: bigint;
  }> {
    this.#logger.log("Submitting Pyth price update...");
    this.#logger.log(`  pyth_vaa contract: ${config.pyth_vaa_contract}`);

    try {
      return await this.#signingClient.updatePrice(priceUpdate, {
        updateFee: config.update_fee,
      });
    } catch (error) {
      if (!isInvalidRouterSetIndex(error)) {
        throw error;
      }

      const rotated = await this.#submitRouterSetUpgrade(config);
      if (!rotated) {
        throw error;
      }

      this.#logger.log("Retrying Pyth price update after router set upgrade...");
      return await this.#signingClient.updatePrice(priceUpdate, {
        updateFee: config.update_fee,
      });
    }
  }

  async #submitRouterSetUpgrade(config: ConfigResponse): Promise<boolean> {
    const routerSetUpdater = this.#config.routerSetUpdater;
    if (!routerSetUpdater) {
      return false;
    }

    this.#logger.warn("Pyth router set is out of sync; checking for signed upgrade VAA...");
    const pythVaaConfig = await this.#signingClient.queryPythVaaConfig(config.pyth_vaa_contract);
    const upgrade = await routerSetUpdater.buildUpgradeVaa(pythVaaConfig);
    if (!upgrade) {
      throw new Error("Pyth router set upgrade required but no signed upgrade VAA is available");
    }

    this.#logger.warn(
      `Submitting pyth_vaa router set upgrade ${upgrade.currentRouterSetIndex} -> ${upgrade.newRouterSetIndex}`,
    );
    const result = await this.#signingClient.submitRouterSetUpgrade({
      pythVaaContract: config.pyth_vaa_contract,
      vaa: upgrade.vaa,
    });
    this.#logger.log(`Router set upgraded successfully! TX: ${result.transactionHash}`);
    if (result.gasUsed !== undefined) {
      this.#logger.log(`  Gas used: ${result.gasUsed}`);
    }

    return true;
  }

  #canIgnorePriceUpdate(newPrice: PythPriceData, currentPrice: PriceResponse): boolean {
    if (newPrice.price.publish_time <= currentPrice.publish_time) {
      this.#logger.log(
        `Price already up to date (publish_time: ${currentPrice.publish_time})`,
      );
      return true;
    }

    if (this.#isPriceDeviationAcceptable(newPrice, currentPrice)) {
      return true;
    }

    return false;
  }

  #isPriceDeviationAcceptable(newPrice: PythPriceData, currentPrice: PriceResponse): boolean {
    const priceDeviationTolerance = this.#config.priceDeviationTolerance;
    if (!priceDeviationTolerance) return false;

    const newPriceValue = parseFloat(newPrice.price.price) * Math.pow(10, newPrice.price.expo);
    const currentPriceValue = parseFloat(currentPrice.price) * Math.pow(10, currentPrice.expo);
    let isAcceptable = false;

    this.#logger.log(`Checking if price deviation is acceptable: new=${newPriceValue}, current=${currentPriceValue}`);

    if (priceDeviationTolerance.type === "absolute") {
      const deviation = Math.abs(newPriceValue - currentPriceValue);
      isAcceptable = deviation <= priceDeviationTolerance.value;

      if (isAcceptable) {
        this.#logger.log(`Price deviation ${deviation} within absolute tolerance ${priceDeviationTolerance.value}, skipping update`);
      }
    } else if (priceDeviationTolerance.type === "percentage") {
      const deviationPercent = currentPriceValue === 0 ? Number.MAX_SAFE_INTEGER : Math.abs(newPriceValue - currentPriceValue) / currentPriceValue;
      isAcceptable = deviationPercent <= priceDeviationTolerance.value / 100;
      if (isAcceptable) {
        this.#logger.log(`Price deviation ${(deviationPercent * 100).toFixed(2)}% within percentage tolerance ${(priceDeviationTolerance.value).toFixed(2)}%, skipping update`);
      }
    } else {
      throw new Error(`Unknown price deviation tolerance type: ${priceDeviationTolerance.type}`);
    }

    return isAcceptable;
  }

  /**
     * Start automatic price updates
     */
  async start(options?: { signal?: AbortSignal }): Promise<void> {
    if (this.#isRunning) {
      this.#logger.log("Hermes client is already running");
      return;
    }

    if (options?.signal?.aborted) return;

    const controller = new AbortController();
    const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;

    // important to be set before any async operation to prevent multiple concurrent starts
    this.#isRunning = true;

    await this.#initialize();
    signal.addEventListener("abort", () => {
      this.#isRunning = false;
      this.#logger.log("Hermes client stopped");
    }, { once: true });

    try {
      this.#logger.log(
        "Starting automatic price consumption",
      );

      const smartContractConfig = await this.#signingClient.queryConfig();
      const priceStream = this.#config.priceProducerFactory({
        priceFeedId: smartContractConfig.price_feed_id,
        signal,
        logger: this.#logger,
      });
      const priceUpdates = latestValue<PriceUpdate>({ signal });
      const consumePrices = async () => {
        try {
          for await (const priceUpdate of priceStream) {
            priceUpdates.set(priceUpdate);

            const price = priceUpdate.priceData.price;
            this.#logger?.log(
              `Received price from Hermes: ${price.price} (expo: ${price.expo})`,
            );
            this.#logger?.log(
              `  Confidence: ${price.conf}, Publish time: ${price.publish_time}`,
            );
            this.#logger?.log(
              `  VAA size: ${priceUpdate.vaa.length} bytes (base64)`,
            );
            this.#lastPriceReceivedAt = new Date().toISOString();
          }
          priceUpdates.close();
        } catch (error) {
          priceUpdates.fail(error);
        }
      };

      consumePrices().catch(() => undefined);

      for await (const priceUpdate of priceUpdates) {
        try {
          await this.#updatePrice(priceUpdate);
        } catch (error) {
          this.#logger.error("Error in scheduled update:", error);
        }
      }
    } catch (error) {
      controller.abort();
      const safeMessage = sanitizeErrorMessage(error, "Failed to start Hermes client");
      this.#logger.error(safeMessage);
      throw new Error(safeMessage);
    } finally {
      await this.#signingClient.disconnect();
      this.#isRunning = false;
    }
  }

  /**
     * Get client status
     */
  async getStatus(): Promise<{
    isRunning: boolean;
    address?: string;
    priceFeedId?: string;
    contractAddress: string;
    lastPriceUpdateReceivedAt?: string;
    lastPriceUpdateAt?: string;
  }> {
    // SEC-08: Only return non-sensitive operational status fields.
    // Never include mnemonic, gasPrice, rpcEndpoint, or full config.
    const [smartContractConfig, account] = await Promise.all([
      this.#signingClient.queryConfig(),
      this.#signingClient.getAccount(),
    ]);

    return {
      isRunning: this.#isRunning,
      address: account.address,
      priceFeedId: smartContractConfig.price_feed_id,
      contractAddress: this.#config.contractAddress,
      lastPriceUpdateReceivedAt: this.#lastPriceReceivedAt,
      lastPriceUpdateAt: this.#lastPriceUpdateAt,
    };
  }
}

export type ErrorCode = "insufficient_balance" | "router_set_out_of_sync" | "timeout" | "connection_issue" | "unknown";

export function classifyError(error: unknown): ErrorCode {
  const message = error instanceof Error ? error.message : "";

  if (/insufficient funds|insufficient fee/i.test(message)) {
    return "insufficient_balance";
  }
  if (isInvalidRouterSetIndex(error)) {
    return "router_set_out_of_sync";
  }
  if (/timeout|ETIMEDOUT/i.test(message)) {
    return "timeout";
  }
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND/i.test(message)) {
    return "connection_issue";
  }
  return "unknown";
}

function isInvalidRouterSetIndex(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return /InvalidRouterSetIndex/i.test(message);
}
