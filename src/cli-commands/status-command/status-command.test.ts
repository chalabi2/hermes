import { describe, it, expect, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { HermesClient } from "../../services/hermes-client/hermes-client.ts";
import type { CommandConfig } from "../command-config.ts";
import { statusCommand } from "./status-command.ts";

function setup() {
  const client = mock<HermesClient>();
  const logger = mock<Console>();
  const config = {
    rpcEndpoint: "https://rpc.akashnet.net:443",
    contractAddress: "akash1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu",
    rawConfig: {
      HERMES_ENDPOINT: "https://pyth.dourolabs.app/hermes",
    },
    logger,
    createHermesClient: vi.fn(() => client),
  } as unknown as CommandConfig;
  return { config, client, logger };
}

describe("statusCommand", () => {
  it("displays client status information", async () => {
    const { config, client, logger } = setup();
    client.getStatus.mockResolvedValueOnce({
      address: "akash1sender",
      contractAddress: "akash1contract",
      priceFeedId: "feed-123",
      isRunning: false,
    });

    await statusCommand(config);

    expect(logger.log).toHaveBeenCalledWith("Contract Status...\n");
    expect(logger.log).toHaveBeenCalledWith("Address:          akash1sender");
    expect(logger.log).toHaveBeenCalledWith("Contract:         akash1contract");
    expect(logger.log).toHaveBeenCalledWith("Price Feed ID:    feed-123");
    expect(logger.log).toHaveBeenCalledWith("Running:          no");
  });

  it("displays running status as yes when client is running", async () => {
    const { config, client, logger } = setup();
    client.getStatus.mockResolvedValueOnce({
      address: "akash1sender",
      contractAddress: "akash1contract",
      priceFeedId: "feed-123",
      isRunning: true,
    });

    await statusCommand(config);

    expect(logger.log).toHaveBeenCalledWith("Running:          yes");
  });

  it("displays RPC and Hermes endpoints from config", async () => {
    const { config, client, logger } = setup();
    client.getStatus.mockResolvedValueOnce({
      address: "akash1sender",
      contractAddress: "akash1contract",
      priceFeedId: "feed-123",
      isRunning: false,
    });

    await statusCommand(config);

    expect(logger.log).toHaveBeenCalledWith("RPC Endpoint:     https://rpc.akashnet.net:443");
    expect(logger.log).toHaveBeenCalledWith("Hermes Endpoint:  https://pyth.dourolabs.app/hermes");
  });

  it("uses default Hermes endpoint when not configured", async () => {
    const { config, client, logger } = setup();
    (config.rawConfig as Record<string, unknown>).HERMES_ENDPOINT = "https://pyth.dourolabs.app/hermes";
    client.getStatus.mockResolvedValueOnce({
      address: "akash1sender",
      contractAddress: "akash1contract",
      priceFeedId: "feed-123",
      isRunning: false,
    });

    await statusCommand(config);

    expect(logger.log).toHaveBeenCalledWith("Hermes Endpoint:  https://pyth.dourolabs.app/hermes");
  });
});
