import { describe, it, expect, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { ContractClientService } from "../../services/contract-client/contract-client.service.ts";
import type { CommandConfig } from "../command-config.ts";
import { queryCommand } from "./query-command.ts";

function setup() {
  const client = mock<ContractClientService>();
  const logger = mock<Console>();
  const config = {
    rpcEndpoint: "https://rpc.akashnet.net:443",
    contractAddress: "akash1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu",
    walletSecret: { type: "mnemonic", value: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" },
    logger,
    createContractClient: vi.fn(() => client),
  } as unknown as CommandConfig;
  return { config, client, logger };
}

describe("queryCommand", () => {
  describe("with --config option", () => {
    it("queries and displays contract configuration", async () => {
      const { config, client, logger } = setup();
      client.queryConfig.mockResolvedValueOnce({
        admin: "akash1admin",
        update_fee: "100",
        price_feed_id: "feed-123",
        pyth_vaa_contract: "akash1vaa",
        default_denom: "uakt",
        default_base_denom: "akt",
      });

      await queryCommand(config, { config: true });

      expect(client.queryConfig).toHaveBeenCalledOnce();
      expect(logger.log).toHaveBeenCalledWith("Contract Configuration:\n");
      expect(logger.log).toHaveBeenCalledWith("Admin:            akash1admin");
      expect(logger.log).toHaveBeenCalledWith("Update Fee:       100");
      expect(logger.log).toHaveBeenCalledWith("Price Feed ID:    feed-123");
      expect(logger.log).toHaveBeenCalledWith("Pyth VAA:         akash1vaa");
      expect(logger.log).toHaveBeenCalledWith("Default Denom:    uakt");
      expect(logger.log).toHaveBeenCalledWith("Base Denom:       akt");
    });
  });

  describe("with --oracle-params option", () => {
    it("queries and displays oracle parameters", async () => {
      const { config, client, logger } = setup();
      client.queryOracleParams.mockResolvedValueOnce({
        max_price_deviation_bps: 500,
        min_price_sources: 3,
        max_price_staleness_blocks: 100,
        twap_window: 300,
        last_updated_height: 42,
      });

      await queryCommand(config, { oracleParams: true });

      expect(client.queryOracleParams).toHaveBeenCalledOnce();
      expect(logger.log).toHaveBeenCalledWith("Cached Oracle Parameters:\n");
      expect(logger.log).toHaveBeenCalledWith("Max Deviation:    500 bps (5%)");
      expect(logger.log).toHaveBeenCalledWith("Min Sources:      3");
      expect(logger.log).toHaveBeenCalledWith("Max Staleness:    100 blocks");
      expect(logger.log).toHaveBeenCalledWith("TWAP Window:      300 blocks");
      expect(logger.log).toHaveBeenCalledWith("Last Updated:     Height 42");
    });
  });

  describe("with --feed option", () => {
    it("queries and displays price feed data", async () => {
      const { config, client, logger } = setup();
      client.queryPriceFeed.mockResolvedValueOnce({
        symbol: "AKT/USD",
        price: "345000000",
        conf: "1000000",
        expo: -8,
        publish_time: 1700000000,
        prev_publish_time: 1699999900,
      });

      await queryCommand(config, { feed: true });

      expect(client.queryPriceFeed).toHaveBeenCalledOnce();
      expect(logger.log).toHaveBeenCalledWith("Price Feed Data:\n");
      expect(logger.log).toHaveBeenCalledWith("Symbol:           AKT/USD");
      expect(logger.log).toHaveBeenCalledWith("Price:            345000000");
      expect(logger.log).toHaveBeenCalledWith("Confidence:       1000000");
      expect(logger.log).toHaveBeenCalledWith("Exponent:         -8");
    });

    it("displays human-readable formatted price", async () => {
      const { config, client, logger } = setup();
      client.queryPriceFeed.mockResolvedValueOnce({
        symbol: "AKT/USD",
        price: "345000000",
        conf: "1000000",
        expo: -8,
        publish_time: 1700000000,
        prev_publish_time: 1699999900,
      });

      await queryCommand(config, { feed: true });

      expect(logger.log).toHaveBeenCalledWith("\nFormatted:");
      expect(logger.log).toHaveBeenCalledWith(
        expect.stringContaining("$3.45000000"),
      );
    });
  });

  describe("default (no options)", () => {
    it("queries and displays current price", async () => {
      const { config, client, logger } = setup();
      client.queryCurrentPrice.mockResolvedValueOnce({
        price: "345000000",
        conf: "1000000",
        expo: -8,
        publish_time: Math.floor(Date.now() / 1000) - 60,
      });

      await queryCommand(config, {});

      expect(client.queryCurrentPrice).toHaveBeenCalledOnce();
      expect(logger.log).toHaveBeenCalledWith("Current Price:\n");
      expect(logger.log).toHaveBeenCalledWith("Price:        345000000");
      expect(logger.log).toHaveBeenCalledWith("Confidence:   1000000");
    });

    it("shows fresh status when price age is under 5 minutes", async () => {
      const { config, client, logger } = setup();
      client.queryCurrentPrice.mockResolvedValueOnce({
        price: "345000000",
        conf: "1000000",
        expo: -8,
        publish_time: Math.floor(Date.now() / 1000) - 60,
      });

      await queryCommand(config, {});

      expect(logger.log).toHaveBeenCalledWith("Price data is fresh");
    });

    it("shows stale warning when price age exceeds 5 minutes", async () => {
      const { config, client, logger } = setup();
      client.queryCurrentPrice.mockResolvedValueOnce({
        price: "345000000",
        conf: "1000000",
        expo: -8,
        publish_time: Math.floor(Date.now() / 1000) - 600,
      });

      await queryCommand(config, {});

      expect(logger.log).toHaveBeenCalledWith(
        "Warning: Price data is stale (>5 minutes old)",
      );
    });
  });
});
