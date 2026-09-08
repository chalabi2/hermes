import type { AccountData } from "@cosmjs/proto-signing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { ContractClient, HermesClient, HermesConfig, classifyError } from "./hermes-client.ts";
import { blockchainPriceStaleness, priceUpdateCounter } from "../../metrics.ts";
import { BroadcastError, type ConfigResponse, type PriceResponse, type PythVaaConfigResponse } from "../contract-client/contract-client.service.ts";
import type { PriceUpdate, PriceProducerFactory, PriceProducerFactoryOptions } from "../../types.ts";

const CONTRACT_ADDRESS = "akash1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu";
const ACCOUNT_ADDRESS = "akash1x0sxpqwzc4jzhqzlmvpqvgvjfnpqxwgvfnkjxs";
const VALID_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

// ============================================================
// SEC-02: URL validation must be enforced on endpoints
// ============================================================
describe("SEC-02: Endpoint URL validation in HermesClient", () => {
  it("rejects HTTP RPC endpoints", () => {
    expect(() => setup({
      rpcEndpoint: "http://insecure-rpc.example.com",
    })).toThrow("only HTTPS endpoints are allowed");
  });

  it("rejects SSRF-targeted RPC endpoints (localhost)", () => {
    expect(() => setup({
      rpcEndpoint: "https://localhost:26657",
    })).toThrow("private or internal addresses are not allowed");
  });

  it("accepts valid HTTPS endpoints", () => {
    const { client } = setup();
    expect(client).toBeDefined();
  });
});

// ============================================================
// SEC-04: Error messages must not leak implementation details
// ============================================================
describe("SEC-04: Error message information leakage", () => {
  it("updatePrice errors do not leak internal paths or stack traces", async () => {
    const { client, contractClient } = setup();
    contractClient.updatePrice.mockRejectedValueOnce(
      new Error("submit failed in /internal/src/hermes-client.ts\n    at Object.<anonymous> (/app/node_modules/@cosmjs/stargate/index.js:1:1)"),
    );

    const result = await client.updatePrice().catch(error => ({ error }));

    expect(result).toHaveProperty("error");
    const { error } = result as { error: Error };
    expect(error.message).not.toMatch(/\/[^\s]+\.(ts|js)/);
    expect(error.message).not.toContain("at ");
    expect(error.message).not.toContain("node_modules");
  });
});

// ============================================================
// SEC-08: Config/status must not expose sensitive data
// ============================================================
describe("SEC-08: Sensitive data in config exposure", () => {
  it("getStatus must not include config object or mnemonic", async () => {
    const { client } = setup();

    const status = await client.getStatus();

    expect(status).toEqual({
      isRunning: false,
      contractAddress: CONTRACT_ADDRESS,
      priceFeedId: "test-feed-id",
      address: ACCOUNT_ADDRESS,
      lastPriceUpdateReceivedAt: undefined,
      lastPriceUpdateAt: undefined,
    });
    expect(JSON.stringify(status)).not.toContain("abandon");
  });
});

describe(HermesClient.name, () => {
  describe("constructor", () => {
    it("allows HTTP endpoints when unsafeAllowInsecureEndpoints is true", () => {
      const { client } = setup({
        rpcEndpoint: "http://rpc.akashnet.net",
        unsafeAllowInsecureEndpoints: true,
      });
      expect(client).toBeDefined();
    });

    it("allows private addresses when unsafeAllowInsecureEndpoints is true", () => {
      const { client } = setup({
        rpcEndpoint: "http://localhost:26657",
        unsafeAllowInsecureEndpoints: true,
      });
      expect(client).toBeDefined();
    });

    it("rejects invalid mnemonic word count", () => {
      expect(() => setup({
        walletSecret: { type: "mnemonic", value: "abandon abandon abandon" },
      })).toThrow("Invalid mnemonic");
    });

    it("rejects mnemonic with invalid characters", () => {
      expect(() => setup({
        walletSecret: { type: "mnemonic", value: "Abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon About" },
      })).toThrow("Invalid mnemonic");
    });

    it("accepts a valid private key", () => {
      const { client } = setup({
        walletSecret: { type: "privateKey", value: "0000000000000000000000000000000000000000000000000000000000000001" },
      });
      expect(client).toBeDefined();
    });

    it("rejects an invalid private key", () => {
      expect(() => setup({
        walletSecret: { type: "privateKey", value: "not-a-valid-hex-key" },
      })).toThrow("Invalid private key");
    });

    it("rejects an invalid contract address", () => {
      expect(() => setup({
        contractAddress: "not-a-contract",
      })).toThrow("Invalid contract address format");
    });
  });

  describe("updatePrice()", () => {
    it("passes the configured price feed id and the abort signal to the price producer", async () => {
      const { client, priceProducerFactory } = setup();
      const ac = new AbortController();

      await client.updatePrice({ signal: ac.signal });

      expect(priceProducerFactory).toHaveBeenCalledWith(expect.objectContaining({
        priceFeedId: "test-feed-id",
        signal: ac.signal,
      }));
    });

    it("submits the VAA when the price is stale", async () => {
      const { client, priceUpdate, contractClient } = setup({
        priceFeed: buildPriceFeed("12400", -2, 2000),
      });
      contractClient.queryCurrentPrice.mockResolvedValue(buildCurrentPrice("12345", -2, 1000));

      await client.updatePrice();

      expect(contractClient.updatePrice).toHaveBeenCalledWith(priceUpdate, { updateFee: "1" });
    });

    it("submits a router-set upgrade to pyth_vaa and retries the price update when the router set is stale", async () => {
      const routerSetUpdater = {
        buildUpgradeVaa: vi.fn().mockResolvedValue({
          vaa: btoa("router-set-upgrade"),
          currentRouterSetIndex: 0,
          newRouterSetIndex: 1,
          signatureCount: 3,
        }),
      };
      const { client, priceUpdate, contractClient } = setup({
        priceFeed: buildPriceFeed("12400", -2, 2000),
        routerSetUpdater,
      });
      const config = buildConfig({
        pyth_vaa_contract: "akash1fyr2mptjswz4w6xmgnpgm93x0q4s4wdl6srv3rtz3utc4f6fmxeqps4ws5",
      });
      const pythVaaConfig = buildPythVaaConfig();
      contractClient.queryConfig.mockResolvedValue(config);
      contractClient.queryCurrentPrice.mockResolvedValue(buildCurrentPrice("12345", -2, 1000));
      contractClient.queryPythVaaConfig.mockResolvedValue(pythVaaConfig);
      contractClient.updatePrice
        .mockRejectedValueOnce(new Error("InvalidRouterSetIndex: query wasm contract failed"))
        .mockResolvedValueOnce({ transactionHash: "PRICE_TX", gasUsed: 500000n });
      contractClient.submitRouterSetUpgrade.mockResolvedValue({ transactionHash: "ROUTER_TX", gasUsed: 300000n });

      await client.updatePrice();

      expect(contractClient.updatePrice).toHaveBeenNthCalledWith(1, priceUpdate, { updateFee: "1" });
      expect(contractClient.queryPythVaaConfig).toHaveBeenCalledWith(config.pyth_vaa_contract);
      expect(routerSetUpdater.buildUpgradeVaa).toHaveBeenCalledWith(pythVaaConfig);
      expect(contractClient.submitRouterSetUpgrade).toHaveBeenCalledWith({
        pythVaaContract: config.pyth_vaa_contract,
        vaa: btoa("router-set-upgrade"),
      });
      expect(contractClient.updatePrice).toHaveBeenNthCalledWith(2, priceUpdate, { updateFee: "1" });
    });

    it("skips the update when no new price is available", async () => {
      const { client, contractClient, logger } = setup({
        priceProducerFactory: (async function* () {}) as unknown as PriceProducerFactory,
      });

      await client.updatePrice();

      expect(contractClient.updatePrice).not.toHaveBeenCalled();
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("no new price was available"));
    });

    it("skips update when price is already up to date", async () => {
      const { client, contractClient, logger } = setup({
        priceFeed: buildPriceFeed("10000", -2, 2000),
      });
      contractClient.queryCurrentPrice.mockResolvedValue(buildCurrentPrice("10000", -2, 2000));

      await client.updatePrice();

      expect(contractClient.updatePrice).not.toHaveBeenCalled();
      expect(logger.log).toHaveBeenCalledWith(
        expect.stringContaining("already up to date"),
      );
    });

    it("skips update when contract has newer publish_time", async () => {
      const { client, contractClient } = setup({
        priceFeed: buildPriceFeed("10000", -2, 2000),
      });
      contractClient.queryCurrentPrice.mockResolvedValue(buildCurrentPrice("10000", -2, 9999999999));

      await client.updatePrice();

      expect(contractClient.updatePrice).not.toHaveBeenCalled();
    });

    it("counts a skipped update", async () => {
      const counterSpy = vi.spyOn(priceUpdateCounter, "add");
      const { client, contractClient } = setup({
        priceFeed: buildPriceFeed("10000", -2, 2000),
      });
      contractClient.queryCurrentPrice.mockResolvedValue(buildCurrentPrice("10000", -2, 2000));

      await client.updatePrice();

      expect(counterSpy).toHaveBeenCalledWith(1, { result: "skipped" });
      counterSpy.mockRestore();
    });

    it("counts a successful update", async () => {
      const counterSpy = vi.spyOn(priceUpdateCounter, "add");
      const { client, contractClient } = setup({
        priceFeed: buildPriceFeed("10000", -2, 2000),
      });
      contractClient.queryCurrentPrice.mockResolvedValue(buildCurrentPrice("9000", -2, 1000));

      await client.updatePrice();

      expect(counterSpy).toHaveBeenCalledWith(1, { result: "success" });
      counterSpy.mockRestore();
    });

    describe("priceDeviationTolerance", () => {
      it("skips update when absolute deviation is within tolerance", async () => {
        const { client, contractClient, logger } = setup({
          priceDeviationTolerance: { type: "absolute", value: 1.0 },
          priceFeed: buildPriceFeed("10000", -2, 2000),
        });
        contractClient.queryCurrentPrice.mockResolvedValue(buildCurrentPrice("10050", -2, 1000));

        await client.updatePrice();

        expect(contractClient.updatePrice).not.toHaveBeenCalled();
        expect(logger.log).toHaveBeenCalledWith(
          expect.stringContaining("absolute tolerance"),
        );
      });

      it("updates when absolute deviation exceeds tolerance", async () => {
        const { client, contractClient } = setup({
          priceDeviationTolerance: { type: "absolute", value: 1.0 },
          priceFeed: buildPriceFeed("10000", -2, 2000),
        });
        contractClient.queryCurrentPrice.mockResolvedValue(buildCurrentPrice("10200", -2, 1000));

        await client.updatePrice();

        expect(contractClient.updatePrice).toHaveBeenCalledTimes(1);
      });

      it("skips update when absolute deviation equals tolerance exactly", async () => {
        const { client, contractClient, logger } = setup({
          priceDeviationTolerance: { type: "absolute", value: 1.0 },
          priceFeed: buildPriceFeed("10000", -2, 2000),
        });
        contractClient.queryCurrentPrice.mockResolvedValue(buildCurrentPrice("10100", -2, 1000));

        await client.updatePrice();

        expect(contractClient.updatePrice).not.toHaveBeenCalled();
        expect(logger.log).toHaveBeenCalledWith(
          expect.stringContaining("absolute tolerance"),
        );
      });

      it("skips update when the price is unchanged and the tolerance is absolute 0", async () => {
        const { client, contractClient } = setup({
          priceDeviationTolerance: { type: "absolute", value: 0 },
          priceFeed: buildPriceFeed("10000", -2, 2000),
        });
        contractClient.queryCurrentPrice.mockResolvedValue(buildCurrentPrice("10000", -2, 1000));

        await client.updatePrice();

        expect(contractClient.updatePrice).not.toHaveBeenCalled();
      });

      it("skips update when percentage deviation is within tolerance", async () => {
        const { client, contractClient, logger } = setup({
          priceDeviationTolerance: { type: "percentage", value: 1 },
          priceFeed: buildPriceFeed("10000", -2, 2000),
        });
        contractClient.queryCurrentPrice.mockResolvedValue(buildCurrentPrice("10050", -2, 1000));

        await client.updatePrice();

        expect(contractClient.updatePrice).not.toHaveBeenCalled();
        expect(logger.log).toHaveBeenCalledWith(
          expect.stringContaining("percentage tolerance"),
        );
      });

      it("updates when percentage deviation exceeds tolerance", async () => {
        const { client, contractClient } = setup({
          priceDeviationTolerance: { type: "percentage", value: 1 },
          priceFeed: buildPriceFeed("10000", -2, 2000),
        });
        contractClient.queryCurrentPrice.mockResolvedValue(buildCurrentPrice("10500", -2, 1000));

        await client.updatePrice();

        expect(contractClient.updatePrice).toHaveBeenCalledTimes(1);
      });

      it("skips update when percentage deviation equals tolerance exactly", async () => {
        const { client, contractClient, logger } = setup({
          priceDeviationTolerance: { type: "percentage", value: 1 },
          priceFeed: buildPriceFeed("10100", -2, 2000),
        });
        contractClient.queryCurrentPrice.mockResolvedValue(buildCurrentPrice("10000", -2, 1000));

        await client.updatePrice();

        expect(contractClient.updatePrice).not.toHaveBeenCalled();
        expect(logger.log).toHaveBeenCalledWith(
          expect.stringContaining("percentage tolerance"),
        );
      });

      it("updates on any price difference when no tolerance is configured", async () => {
        const { client, contractClient } = setup({
          priceFeed: buildPriceFeed("10001", -2, 2000),
        });
        contractClient.queryCurrentPrice.mockResolvedValue(buildCurrentPrice("10000", -2, 1000));

        await client.updatePrice();

        expect(contractClient.updatePrice).toHaveBeenCalledTimes(1);
      });

      it("updates on an unchanged price when no tolerance is configured", async () => {
        const { client, contractClient } = setup({
          priceFeed: buildPriceFeed("10000", -2, 2000),
        });
        contractClient.queryCurrentPrice.mockResolvedValue(buildCurrentPrice("10000", -2, 1000));

        await client.updatePrice();

        expect(contractClient.updatePrice).toHaveBeenCalledTimes(1);
      });

      it("does not run a deviation check when no tolerance is configured", async () => {
        const { client, logger } = setup({
          priceFeed: buildPriceFeed("10000", -2, 2000),
        });

        await client.updatePrice();

        expect(logger.log).not.toHaveBeenCalledWith(
          expect.stringContaining("Checking if price deviation is acceptable"),
        );
      });

      it("handles different exponents between new and current price", async () => {
        const { client, contractClient } = setup({
          priceDeviationTolerance: { type: "absolute", value: 1.0 },
          priceFeed: buildPriceFeed("1000000", -4, 2000),
        });
        contractClient.queryCurrentPrice.mockResolvedValue(buildCurrentPrice("10200", -2, 1000));

        await client.updatePrice();

        expect(contractClient.updatePrice).toHaveBeenCalledTimes(1);
      });

      it("fails the update on an unknown tolerance type", async () => {
        const { client } = setup({
          priceDeviationTolerance: { type: "relative", value: 1 } as unknown as HermesConfig["priceDeviationTolerance"],
          priceFeed: buildPriceFeed("10000", -2, 2000),
        });

        await expect(client.updatePrice()).rejects.toThrow("Failed to update price: Unknown price deviation tolerance type: relative");
      });

      it("handles zero current price when calculating percentage deviation", async () => {
        const { client, contractClient } = setup({
          priceDeviationTolerance: { type: "percentage", value: 10 },
          priceFeed: buildPriceFeed("10000", -2, 2000),
        });
        contractClient.queryCurrentPrice.mockResolvedValue(buildCurrentPrice("0", -2, 1000));

        await client.updatePrice();

        expect(contractClient.updatePrice).toHaveBeenCalledTimes(1);
      });
    });

    it("records price staleness on successful update", async () => {
      const stalenessSpy = vi.spyOn(blockchainPriceStaleness, "record");
      const { client, contractClient } = setup({
        priceFeed: buildPriceFeed("10000", -2, 2000),
      });
      contractClient.queryCurrentPrice.mockResolvedValue(buildCurrentPrice("9000", -2, 1000));

      await client.updatePrice();

      expect(stalenessSpy).toHaveBeenCalledWith(1000);
      stalenessSpy.mockRestore();
    });

    it("records price staleness on skipped update", async () => {
      const stalenessSpy = vi.spyOn(blockchainPriceStaleness, "record");
      const { client, contractClient } = setup({
        priceFeed: buildPriceFeed("10000", -2, 2000),
      });
      contractClient.queryCurrentPrice.mockResolvedValue(buildCurrentPrice("10000", -2, 2000));

      await client.updatePrice();

      expect(stalenessSpy).toHaveBeenCalledWith(0);
      stalenessSpy.mockRestore();
    });

    it("records error_code attribute and staleness on failure", async () => {
      const counterSpy = vi.spyOn(priceUpdateCounter, "add");
      const stalenessSpy = vi.spyOn(blockchainPriceStaleness, "record");
      const { client, contractClient } = setup({
        priceFeed: buildPriceFeed("10000", -2, 2000),
      });
      contractClient.queryCurrentPrice.mockResolvedValue(buildCurrentPrice("9000", -2, 1000));
      contractClient.updatePrice.mockRejectedValueOnce(new Error("insufficient funds"));

      await client.updatePrice().catch(() => {});

      expect(counterSpy).toHaveBeenCalledWith(1, { result: "failure", error_code: "insufficient_balance" });
      expect(stalenessSpy).toHaveBeenCalledWith(1000);
      counterSpy.mockRestore();
      stalenessSpy.mockRestore();
    });

    it("records the timestamp of the last successful update", async () => {
      const { client, contractClient } = setup({
        priceFeed: buildPriceFeed("10000", -2, 2000),
      });
      contractClient.queryCurrentPrice.mockResolvedValue(buildCurrentPrice("9000", -2, 1000));

      await client.updatePrice();

      const status = await client.getStatus();
      expect(status.lastPriceUpdateAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    describe("insufficient balance cooldown", () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      it("skips submissions during the cooldown and retries once it expires", async () => {
        vi.useFakeTimers();
        const { client, contractClient, logger } = setup({
          priceFeed: buildPriceFeed("10000", -2, 2000),
          insufficientBalanceRetryDelayMs: 5000,
        });
        contractClient.queryCurrentPrice.mockResolvedValue(buildCurrentPrice("9000", -2, 1000));
        contractClient.updatePrice.mockRejectedValueOnce(new Error("insufficient funds"));

        await client.updatePrice().catch(() => {});
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("insufficient balance cooldown for 5000ms"));

        // Within the cooldown window the submission is skipped entirely.
        await client.updatePrice();
        expect(contractClient.updatePrice).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("cooldown active"));

        vi.advanceTimersByTime(5000);
        await client.updatePrice();

        expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("cooldown expired"));
        expect(contractClient.updatePrice).toHaveBeenCalledTimes(2);
      });

      it("clears the cooldown after a successful submission", async () => {
        vi.useFakeTimers();
        const { client, contractClient } = setup({
          priceFeed: buildPriceFeed("10000", -2, 2000),
          insufficientBalanceRetryDelayMs: 5000,
        });
        contractClient.queryCurrentPrice.mockResolvedValue(buildCurrentPrice("9000", -2, 1000));
        contractClient.updatePrice.mockRejectedValueOnce(new Error("insufficient funds"));

        await client.updatePrice().catch(() => {});
        vi.advanceTimersByTime(5000);
        await client.updatePrice();
        await client.updatePrice();

        expect(contractClient.updatePrice).toHaveBeenCalledTimes(3);
      });
    });
  });

  describe("start()", () => {
    it("starts once if called concurrently", async () => {
      const priceUpdate = buildPriceFeed("12345", -2, 2000);
      const factory = blockingFactory(priceUpdate);
      const { client, contractClient } = setup({ priceProducerFactory: factory });
      const start = client.start.bind(client);
      const abortController = new AbortController();

      contractClient.queryCurrentPrice.mockResolvedValue(buildCurrentPrice("9000", -2, 1000));

      const allPromise = Promise.all([
        start({ signal: abortController.signal }),
        start({ signal: abortController.signal }),
        start({ signal: abortController.signal }),
        start({ signal: abortController.signal }),
      ]);

      await vi.waitFor(() => {
        expect(contractClient.updatePrice).toHaveBeenCalledTimes(1);
      });

      abortController.abort();
      await allPromise;

      expect(factory).toHaveBeenCalledTimes(1);
    });

    it("logs and returns when already running", async () => {
      const factory = blockingFactory(buildPriceFeed("10000", -2, 2000));
      const { client, logger } = setup({ priceProducerFactory: factory });
      const abortController = new AbortController();

      const startPromise = client.start({ signal: abortController.signal });
      await vi.waitFor(async () => {
        expect((await client.getStatus()).isRunning).toBe(true);
      });
      await client.start({ signal: abortController.signal });

      expect(logger.log).toHaveBeenCalledWith("Hermes client is already running");

      abortController.abort();
      await startPromise;
    });

    it("returns immediately when the signal is already aborted", async () => {
      const { client, priceProducerFactory } = setup();

      await client.start({ signal: AbortSignal.abort() });

      expect(priceProducerFactory).not.toHaveBeenCalled();
      expect((await client.getStatus()).isRunning).toBe(false);
    });

    it("feeds the producer with the price feed id from the contract configuration", async () => {
      const { client, priceProducerFactory, contractClient } = setup();
      contractClient.queryConfig.mockResolvedValue(buildConfig({ price_feed_id: "other-feed-id" }));

      const abortController = new AbortController();
      await client.start({ signal: abortController.signal });
      abortController.abort();

      expect(priceProducerFactory).toHaveBeenCalledWith(expect.objectContaining({
        priceFeedId: "other-feed-id",
      }));
    });

    it("stops when abort signal fires", async () => {
      const factory = blockingFactory(buildPriceFeed("10000", -2, 2000));
      const { client, logger } = setup({ priceProducerFactory: factory });
      const ac = new AbortController();

      const startPromise = client.start({ signal: ac.signal });
      await vi.waitFor(async () => {
        expect((await client.getStatus()).isRunning).toBe(true);
      });

      ac.abort();
      await startPromise;

      expect((await client.getStatus()).isRunning).toBe(false);
      expect(logger.log).toHaveBeenCalledWith("Hermes client stopped");
    });

    it("continues running when updatePrice throws", async () => {
      const { client, contractClient, logger } = setup();
      const abortController = new AbortController();

      contractClient.queryCurrentPrice.mockRejectedValue(new Error("query failed"));

      await client.start({ signal: abortController.signal });
      abortController.abort();

      expect(logger.error).toHaveBeenCalledWith(
        "Error in scheduled update:",
        expect.any(Error),
      );
    });

    it("propagates a producer failure to the consumer", async () => {
      const factory = vi.fn(async function* () {
        yield buildPriceFeed("10000", -2, 2000);
        throw new Error("stream broke");
      });
      const { client, contractClient } = setup({ priceProducerFactory: factory as unknown as PriceProducerFactory });
      contractClient.queryCurrentPrice.mockResolvedValue(buildCurrentPrice("9000", -2, 1000));

      const ac = new AbortController();
      await expect(client.start({ signal: ac.signal })).rejects.toThrow("Failed to start Hermes client");
      ac.abort();

      expect(contractClient.updatePrice).toHaveBeenCalledTimes(1);
    });

    it("rejects when the contract configuration cannot be fetched", async () => {
      const { client, contractClient } = setup();

      contractClient.queryConfig.mockRejectedValueOnce(new Error("connection refused"));

      const ac = new AbortController();
      try {
        await expect(client.start({ signal: ac.signal })).rejects.toThrow("Failed to initialize Hermes client: connection refused");
      } finally {
        ac.abort();
      }
    });

    it("sets lastPriceUpdateReceivedAt in ISO-8601 format after receiving a price update", async () => {
      const factory = blockingFactory(buildPriceFeed("10000", -2, 2000));
      const { client, contractClient } = setup({ priceProducerFactory: factory });
      const ac = new AbortController();

      contractClient.queryCurrentPrice.mockResolvedValue(buildCurrentPrice("9000", -2, 1000));

      const startPromise = client.start({ signal: ac.signal });
      await vi.waitFor(async () => {
        const status = await client.getStatus();
        expect(status.lastPriceUpdateReceivedAt).toBeDefined();
      });

      const status = await client.getStatus();
      expect(status.lastPriceUpdateReceivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

      ac.abort();
      await startPromise;
    });

    it("lastPriceUpdateReceivedAt is undefined before any price update is received", async () => {
      const { client } = setup();

      const status = await client.getStatus();
      expect(status.lastPriceUpdateReceivedAt).toBeUndefined();
    });

    it("drops updates that arrive while a price update is in flight, keeping the latest", async () => {
      const priceUpdate1 = buildPriceFeed("10000", -2, 2000, "vaa-1");
      const priceUpdate2 = buildPriceFeed("10100", -2, 3000, "vaa-2");
      const priceUpdate3 = buildPriceFeed("10200", -2, 4000, "vaa-3");
      // Hold the first on-chain update open so updates 2 and 3 both arrive while it is in flight.
      const { promise: firstUpdateInFlight, resolve: releaseFirstUpdate } = Promise.withResolvers<void>();
      const { promise: firstUpdateStarted, resolve: firstUpdateReached } = Promise.withResolvers<void>();
      const factory = vi.fn(async function* () {
        yield priceUpdate1;
        await firstUpdateStarted;
        yield priceUpdate2;
        yield priceUpdate3;
        releaseFirstUpdate();
      });
      const { client, contractClient } = setup({ priceProducerFactory: factory as unknown as PriceProducerFactory });

      contractClient.queryCurrentPrice.mockResolvedValue(buildCurrentPrice("9000", -2, 1000));
      const receipt = { transactionHash: "TX", gasUsed: 500000n };
      contractClient.updatePrice
        .mockImplementationOnce(async () => {
          firstUpdateReached();
          await firstUpdateInFlight;
          return receipt;
        })
        .mockResolvedValue(receipt);

      const ac = new AbortController();
      await client.start({ signal: ac.signal });
      ac.abort();

      const submittedVaas = contractClient.updatePrice.mock.calls.map(([update]) => update.vaa);
      expect(submittedVaas).toEqual([btoa("vaa-1"), btoa("vaa-3")]);
    });
  });

  describe("classifyError()", () => {
    it('returns "insufficient_balance" for insufficient funds error', () => {
      expect(classifyError(new Error("insufficient funds: 100uakt < 1000uakt"))).toBe("insufficient_balance");
    });

    it('returns "insufficient_balance" for insufficient fee error', () => {
      expect(classifyError(new Error("insufficient fee"))).toBe("insufficient_balance");
    });

    it('returns "insufficient_balance" for a failed unordered broadcast that ran out of funds', () => {
      // The unordered path reports an on-chain failure as a BroadcastError; without its raw log the code alone is
      // unclassifiable (sdk 5 is insufficient funds, wasm 5 is a contract revert) and the cooldown would never engage.
      const error = new BroadcastError({
        code: 5,
        rawLog: "failed to execute message; message index: 0: spendable balance 100uakt is smaller than 250uakt: insufficient funds",
        transactionHash: "FAILED_TX_HASH",
      });

      expect(classifyError(error)).toBe("insufficient_balance");
    });

    it('returns "timeout" for timeout error', () => {
      expect(classifyError(new Error("request timeout"))).toBe("timeout");
    });

    it('returns "timeout" for ETIMEDOUT error', () => {
      expect(classifyError(new Error("connect ETIMEDOUT 1.2.3.4:443"))).toBe("timeout");
    });

    it('returns "connection_issue" for ECONNREFUSED error', () => {
      expect(classifyError(new Error("connect ECONNREFUSED 127.0.0.1:26657"))).toBe("connection_issue");
    });

    it('returns "connection_issue" for ECONNRESET error', () => {
      expect(classifyError(new Error("read ECONNRESET"))).toBe("connection_issue");
    });

    it('returns "connection_issue" for ENOTFOUND error', () => {
      expect(classifyError(new Error("getaddrinfo ENOTFOUND rpc.example.com"))).toBe("connection_issue");
    });

    it('returns "unknown" for unrecognized errors', () => {
      expect(classifyError(new Error("something unexpected"))).toBe("unknown");
    });

    it('returns "unknown" for non-Error values', () => {
      expect(classifyError("string error")).toBe("unknown");
    });
  });
});

function setup(input?: Partial<HermesConfig> & {
  priceFeed?: PriceUpdate;
}) {
  const priceUpdate: PriceUpdate = input?.priceFeed ?? buildPriceFeed("123.45", -8, 1234567890);

  const priceProducerFactory = vi.fn(async function* () {
    yield priceUpdate;
  });

  const contractClient = mock<ContractClient>();
  contractClient.getAccount.mockResolvedValue(buildAccount());
  contractClient.queryConfig.mockResolvedValue(buildConfig());
  contractClient.queryCurrentPrice.mockResolvedValue(buildCurrentPrice("0", -2, 0));
  contractClient.queryPythVaaConfig.mockResolvedValue(buildPythVaaConfig());
  contractClient.updatePrice.mockResolvedValue({ transactionHash: "TX_DEFAULT", gasUsed: 500000n });
  contractClient.submitRouterSetUpgrade.mockResolvedValue({ transactionHash: "TX_ROUTER_SET", gasUsed: 300000n });

  const logger = mock<Console>();
  const client = new HermesClient({
    rpcEndpoint: input?.rpcEndpoint ?? "https://rpc.akashnet.net:443",
    contractAddress: input?.contractAddress ?? CONTRACT_ADDRESS,
    walletSecret: input?.walletSecret ?? { type: "mnemonic", value: VALID_MNEMONIC },
    gasPrice: input?.gasPrice ?? "0.025uakt",
    logger,
    unsafeAllowInsecureEndpoints: input?.unsafeAllowInsecureEndpoints,
    priceDeviationTolerance: input?.priceDeviationTolerance,
    priceProducerFactory: (input?.priceProducerFactory ?? priceProducerFactory) as PriceProducerFactory,
    smartContractConfigCacheTTLMs: input?.smartContractConfigCacheTTLMs ?? 60_000,
    unorderedTxTtlMs: input?.unorderedTxTtlMs ?? 180_000,
    insufficientBalanceRetryDelayMs: input?.insufficientBalanceRetryDelayMs,
    contractClientFactory: () => contractClient,
    denom: "uakt",
    gasMultiplier: 1.5,
    priceUpdateTxMethod: input?.priceUpdateTxMethod ?? "ordered",
    routerSetUpdater: input?.routerSetUpdater,
  });

  return { client, priceUpdate, priceProducerFactory, logger, contractClient };
}

function buildPriceFeed(price: string, expo: number, publishTime: number, vaa = "vaa-data"): PriceUpdate {
  return {
    priceData: {
      id: "test-id",
      price: { price, conf: "10", expo, publish_time: publishTime },
      ema_price: { price, conf: "10", expo, publish_time: publishTime },
    },
    vaa: btoa(vaa),
  };
}

function buildCurrentPrice(price: string, expo: number, publishTime: number): PriceResponse {
  return { price, conf: "10", expo, publish_time: publishTime };
}

function buildConfig(overrides?: Partial<ConfigResponse>): ConfigResponse {
  return {
    admin: "akash1admin",
    pyth_vaa_contract: "akash1vaa",
    update_fee: "1",
    price_feed_id: "test-feed-id",
    default_denom: "uakt",
    default_base_denom: "akt",
    ...overrides,
  };
}

function buildPythVaaConfig(overrides?: Partial<PythVaaConfigResponse>): PythVaaConfigResponse {
  return {
    admin: "akash1admin",
    governance_target_chain: 29,
    router_verifier: {
      router_set_index: 0,
      routers: [
        "QVNLsXbkYaP7MEeUAPIQVJ7M5jg=",
        "ZQKYe2LyHKt+tczY8BcwhLYNW0E=",
        "RKPo9qOCQSz2u5Cj+BBuaJd0dsk=",
        "E+3HdtMGNUn9sHAq8YLtyQWlOdQ=",
        "OvCIhUu3aAZfSSnlu9+ky7BMmvk=",
      ].map(bytes => ({ bytes })),
      expected_emitter_chain: 26,
      expected_emitter_address: "UHl0aG5ldFB5dGhuZXRQeXRobmV0UHl0aG5ldFB5dGg=",
    },
    ...overrides,
  };
}

function buildAccount(): AccountData {
  return { address: ACCOUNT_ADDRESS, algo: "secp256k1", pubkey: new Uint8Array(33) };
}

function blockingFactory(priceUpdate: PriceUpdate) {
  return vi.fn(async function* ({ signal }: PriceProducerFactoryOptions) {
    yield priceUpdate;
    if (signal && !signal.aborted) {
      await new Promise<void>(resolve => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  });
}
