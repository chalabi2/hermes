import type { ExecuteResult, SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { fromUtf8 } from "@cosmjs/encoding";
import { Registry, type EncodeObject } from "@cosmjs/proto-signing";
import { defaultRegistryTypes, GasPrice, QueryClient, type Account, type DeliverTxResponse } from "@cosmjs/stargate";
import type { Comet38Client } from "@cosmjs/tendermint-rpc";
import { SimulateResponse } from "cosmjs-types/cosmos/tx/v1beta1/service";
import { TxBody, TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { MsgExecuteContract } from "cosmjs-types/cosmwasm/wasm/v1/tx";
import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";

import type { SigningClient } from "../../lib/signing-stargate-client/signing-stargate-client.service.ts";
import type { PriceUpdate } from "../../types.ts";
import { BroadcastError, ContractClientService, type ConfigResponse, type SigningClientServiceConfig } from "./contract-client.service.ts";

/** Well-known test vectors: the derived addresses pin both the akash prefix and the cosmos HD path. */
const PRIVATE_KEY = "b1c2f3d4e5a60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const PRIVATE_KEY_ADDRESS = "akash1td2hmee6u8lt5n0fk3mwvme65zrj3vpf6anh6r";
const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const MNEMONIC_ADDRESS = "akash19rl4cm2hmr8afy4kldpxz3fka4jguq0a3mq6x0";
const CONTRACT_ADDRESS = "akash1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu";
const PYTH_VAA_CONTRACT_ADDRESS = "akash1fyr2mptjswz4w6xmgnpgm93x0q4s4wdl6srv3rtz3utc4f6fmxeqps4ws5";
const RPC_ENDPOINT = "https://rpc.akashnet.net:443";

describe(ContractClientService.name, () => {
  describe("getAccount", () => {
    it("derives the account from a hex private key", async () => {
      const { client } = setup({ walletSecret: { type: "privateKey", value: PRIVATE_KEY } });

      const account = await client.getAccount();

      expect(account.address).toBe(PRIVATE_KEY_ADDRESS);
      expect(account.algo).toBe("secp256k1");
    });

    it("derives the account from a mnemonic", async () => {
      const { client } = setup({ walletSecret: { type: "mnemonic", value: MNEMONIC } });

      const account = await client.getAccount();

      expect(account.address).toBe(MNEMONIC_ADDRESS);
    });
  });

  describe("rpc connection", () => {
    it("connects to the configured endpoint with the derived signer and gas price", async () => {
      const { client, connectWithSigner } = setup({ rpcEndpoint: RPC_ENDPOINT, gasPrice: "0.03uakt" });

      await client.queryCurrentPrice();

      const [endpoint, signer, options] = connectWithSigner.mock.calls[0];
      expect(endpoint).toBe(RPC_ENDPOINT);
      expect(await signer.getAccounts()).toEqual([expect.objectContaining({ address: PRIVATE_KEY_ADDRESS })]);
      expect(options?.gasPrice).toEqual(GasPrice.fromString("0.03uakt"));
    });

    it("opens a single connection shared by every operation", async () => {
      const { client, connectWithSigner, signingClient } = setup();
      signingClient.queryContractSmart.mockResolvedValue(createConfigResponse());

      await Promise.all([client.queryConfig(), client.queryCurrentPrice(), client.getAccount()]);
      await client.queryPriceFeed();

      expect(connectWithSigner).toHaveBeenCalledTimes(1);
    });

    it("retries the connection on the next call after a failed one", async () => {
      const { client, connectWithSigner } = setup();
      connectWithSigner.mockRejectedValueOnce(new Error("rpc unreachable"));

      // A memoized rejection would poison the daemon for its whole lifetime after one transient RPC failure.
      await expect(client.queryCurrentPrice()).rejects.toThrow("rpc unreachable");
      await expect(client.queryCurrentPrice()).resolves.toBeDefined();
      expect(connectWithSigner).toHaveBeenCalledTimes(2);
    });
  });

  describe("updatePrice in an ordered tx", () => {
    it("executes the price feed update against the contract, funding it with the update fee", async () => {
      const { client, signingClient, priceUpdate } = setup({ priceUpdateTxMethod: "ordered", denom: "uakt", gasMultiplier: 1.5 });

      const result = await client.updatePrice(priceUpdate, { updateFee: "250" });

      expect(signingClient.execute).toHaveBeenCalledWith(
        PRIVATE_KEY_ADDRESS,
        CONTRACT_ADDRESS,
        { update_price_feed: { vaa: priceUpdate.vaa } },
        1.5,
        undefined,
        [{ denom: "uakt", amount: "250" }],
      );
      expect(result).toEqual({ transactionHash: "ORDERED_TX_HASH", gasUsed: 120_000n });
    });

    it("is the default when no tx method is configured", async () => {
      const { client, signingClient, priceUpdate } = setup({ priceUpdateTxMethod: undefined });

      await client.updatePrice(priceUpdate, { updateFee: "1" });

      expect(signingClient.execute).toHaveBeenCalledTimes(1);
      expect(signingClient.broadcastTx).not.toHaveBeenCalled();
    });
  });

  describe("updatePrice in an unordered tx", () => {
    it("broadcasts a signed unordered tx carrying the price feed update", async () => {
      const { client, signingClient, priceUpdate } = setup({ priceUpdateTxMethod: "unordered", denom: "uakt" });

      await client.updatePrice(priceUpdate, { updateFee: "250" });

      expect(signingClient.execute).not.toHaveBeenCalled();
      const body = TxBody.decode(TxRaw.decode(signingClient.broadcastTx.mock.calls[0][0]).bodyBytes);
      expect(body.unordered).toBe(true);
      expect(body.messages[0].typeUrl).toBe("/cosmwasm.wasm.v1.MsgExecuteContract");

      const executeMsg = MsgExecuteContract.decode(body.messages[0].value);
      expect(executeMsg.sender).toBe(PRIVATE_KEY_ADDRESS);
      expect(executeMsg.contract).toBe(CONTRACT_ADDRESS);
      expect(executeMsg.funds).toEqual([{ denom: "uakt", amount: "250" }]);
      expect(JSON.parse(fromUtf8(executeMsg.msg))).toEqual({ update_price_feed: { vaa: priceUpdate.vaa } });
    });

    it("returns the hash and gas used reported by the broadcast", async () => {
      const { client, priceUpdate } = setup({ priceUpdateTxMethod: "unordered" });

      const result = await client.updatePrice(priceUpdate, { updateFee: "250" });

      expect(result).toEqual({ transactionHash: "UNORDERED_TX_HASH", gasUsed: 90_000n });
    });

    it("throws when the chain rejects the broadcast", async () => {
      const { client, signingClient, priceUpdate } = setup({ priceUpdateTxMethod: "unordered" });
      signingClient.broadcastTx.mockResolvedValue(mock<DeliverTxResponse>({ code: 11, rawLog: "out of gas", transactionHash: "FAILED_TX_HASH", gasUsed: 90_000n }));

      // A non-zero code is a failed tx that still lands on chain, so the caller must not treat the hash as a success.
      await expect(client.updatePrice(priceUpdate, { updateFee: "250" })).rejects.toThrow(BroadcastError);
      await expect(client.updatePrice(priceUpdate, { updateFee: "250" })).rejects.toThrow("Broadcast failed with code 11");
    });

    it("reports the chain's raw log and the tx hash of a failed broadcast", async () => {
      const { client, signingClient, priceUpdate } = setup({ priceUpdateTxMethod: "unordered" });
      const rawLog = "failed to execute message; message index: 0: spendable balance 100uakt is smaller than 250uakt: insufficient funds";
      signingClient.broadcastTx.mockResolvedValue(mock<DeliverTxResponse>({ code: 5, rawLog, transactionHash: "FAILED_TX_HASH", gasUsed: 90_000n }));

      // The code alone is ambiguous across codespaces, and the codespace never reaches us: the raw log is what names the
      // failure, and the hash is what lets it be looked up on chain. Both have to survive into the message the daemon logs.
      const error = await client.updatePrice(priceUpdate, { updateFee: "250" })
        .catch((error: unknown) => error) as BroadcastError;
      expect(error.message).toContain(rawLog);
      expect(error.message).toContain("FAILED_TX_HASH");
      expect(error).toMatchObject({ code: 5, rawLog, transactionHash: "FAILED_TX_HASH" });
    });

    it("points at the tx hash when the chain reports no log", async () => {
      const { client, signingClient, priceUpdate } = setup({ priceUpdateTxMethod: "unordered" });
      // `rawLog` is deprecated in the sdk, so an empty one must still leave a way to diagnose the failure.
      signingClient.broadcastTx.mockResolvedValue(mock<DeliverTxResponse>({ code: 5, rawLog: "", transactionHash: "FAILED_TX_HASH", gasUsed: 90_000n }));

      await expect(client.updatePrice(priceUpdate, { updateFee: "250" })).rejects.toThrow(
        "Broadcast failed with code 5 (tx FAILED_TX_HASH): chain returned no log; query the tx by hash for the module error",
      );
    });

    it("signs the price update through a single unordered signing client", async () => {
      const { client, signingClient, priceUpdate } = setup({ priceUpdateTxMethod: "unordered" });

      await client.updatePrice(priceUpdate, { updateFee: "250" });
      await client.updatePrice(priceUpdate, { updateFee: "250" });

      expect(signingClient.broadcastTx).toHaveBeenCalledTimes(2);
      expect(signingClient.getChainId).toHaveBeenCalledTimes(1);
    });
  });

  describe("submitRouterSetUpgrade", () => {
    it("executes the router-set upgrade against the pyth_vaa contract without funds", async () => {
      const { client, signingClient } = setup({ priceUpdateTxMethod: "ordered", gasMultiplier: 1.5 });
      const vaa = btoa("router-set-upgrade");

      const result = await client.submitRouterSetUpgrade({
        pythVaaContract: PYTH_VAA_CONTRACT_ADDRESS,
        vaa,
      });

      expect(signingClient.execute).toHaveBeenCalledWith(
        PRIVATE_KEY_ADDRESS,
        PYTH_VAA_CONTRACT_ADDRESS,
        { submit_v_a_a: { vaa } },
        1.5,
        undefined,
        undefined,
      );
      expect(result).toEqual({ transactionHash: "ORDERED_TX_HASH", gasUsed: 120_000n });
    });

    it("broadcasts an unordered tx carrying the router-set upgrade to pyth_vaa", async () => {
      const { client, signingClient } = setup({ priceUpdateTxMethod: "unordered" });
      const vaa = btoa("router-set-upgrade");

      await client.submitRouterSetUpgrade({
        pythVaaContract: PYTH_VAA_CONTRACT_ADDRESS,
        vaa,
      });

      expect(signingClient.execute).not.toHaveBeenCalled();
      const body = TxBody.decode(TxRaw.decode(signingClient.broadcastTx.mock.calls[0][0]).bodyBytes);
      expect(body.unordered).toBe(true);
      expect(body.messages[0].typeUrl).toBe("/cosmwasm.wasm.v1.MsgExecuteContract");

      const executeMsg = MsgExecuteContract.decode(body.messages[0].value);
      expect(executeMsg.sender).toBe(PRIVATE_KEY_ADDRESS);
      expect(executeMsg.contract).toBe(PYTH_VAA_CONTRACT_ADDRESS);
      expect(executeMsg.funds).toEqual([]);
      expect(JSON.parse(fromUtf8(executeMsg.msg))).toEqual({ submit_v_a_a: { vaa } });
    });

    it("queries pyth_vaa config from the supplied pyth_vaa address", async () => {
      const { client, signingClient } = setup();
      const config = {
        admin: MNEMONIC_ADDRESS,
        governance_target_chain: 29,
        router_verifier: {
          router_set_index: 1,
          routers: Array.from({ length: 5 }, () => ({ bytes: "QVNLsXbkYaP7MEeUAPIQVJ7M5jg=" })),
          expected_emitter_chain: 26,
          expected_emitter_address: "UHl0aG5ldFB5dGhuZXRQeXRobmV0UHl0aG5ldFB5dGg=",
        },
      };
      signingClient.queryContractSmart.mockResolvedValue(config);

      await expect(client.queryPythVaaConfig(PYTH_VAA_CONTRACT_ADDRESS)).resolves.toEqual(config);
      expect(signingClient.queryContractSmart).toHaveBeenCalledWith(
        PYTH_VAA_CONTRACT_ADDRESS,
        { get_config: {} },
      );
    });
  });

  describe("contract queries", () => {
    it("queries the current price", async () => {
      const { client, signingClient } = setup();
      const price = { price: "12345", conf: "10", expo: -8, publish_time: 1_700_000_000 };
      signingClient.queryContractSmart.mockResolvedValue(price);

      await expect(client.queryCurrentPrice()).resolves.toEqual(price);
      expect(signingClient.queryContractSmart).toHaveBeenCalledWith(CONTRACT_ADDRESS, { get_price: {} });
    });

    it("queries the price feed", async () => {
      const { client, signingClient } = setup();
      const feed = { symbol: "AKT/USD", price: "12345", conf: "10", expo: -8, publish_time: 1_700_000_000, prev_publish_time: 1_699_999_000 };
      signingClient.queryContractSmart.mockResolvedValue(feed);

      await expect(client.queryPriceFeed()).resolves.toEqual(feed);
      expect(signingClient.queryContractSmart).toHaveBeenCalledWith(CONTRACT_ADDRESS, { get_price_feed: {} });
    });

    it("queries the oracle params", async () => {
      const { client, signingClient } = setup();
      const params = { max_price_deviation_bps: 500, min_price_sources: 1, max_price_staleness_blocks: 100, twap_window: 60, last_updated_height: 42 };
      signingClient.queryContractSmart.mockResolvedValue(params);

      await expect(client.queryOracleParams()).resolves.toEqual(params);
      expect(signingClient.queryContractSmart).toHaveBeenCalledWith(CONTRACT_ADDRESS, { get_oracle_params: {} });
    });
  });

  describe("queryConfig", () => {
    it("queries the contract config", async () => {
      const { client, signingClient } = setup();
      const config = createConfigResponse();
      signingClient.queryContractSmart.mockResolvedValue(config);

      await expect(client.queryConfig()).resolves.toEqual(config);
      expect(signingClient.queryContractSmart).toHaveBeenCalledWith(CONTRACT_ADDRESS, { get_config: {} });
    });

    it("serves the cached config until the ttl expires, then refetches", async () => {
      vi.useFakeTimers();
      try {
        const { client, signingClient } = setup({ smartContractConfigCacheTTLMs: 60_000 });
        signingClient.queryContractSmart.mockResolvedValue(createConfigResponse());
        const start = Date.now();

        await client.queryConfig();
        vi.setSystemTime(start + 59_000);
        await client.queryConfig();
        expect(signingClient.queryContractSmart).toHaveBeenCalledTimes(1);

        vi.setSystemTime(start + 61_000);
        await client.queryConfig();
        expect(signingClient.queryContractSmart).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("shares one in-flight request between concurrent callers", async () => {
      const { client, signingClient } = setup();
      const config = createConfigResponse();
      signingClient.queryContractSmart.mockResolvedValue(config);

      await expect(Promise.all([client.queryConfig(), client.queryConfig()])).resolves.toEqual([config, config]);
      expect(signingClient.queryContractSmart).toHaveBeenCalledTimes(1);
    });

    it("does not cache a failed query", async () => {
      const { client, signingClient } = setup({ smartContractConfigCacheTTLMs: 60_000 });
      const config = createConfigResponse();
      signingClient.queryContractSmart.mockRejectedValueOnce(new Error("node down")).mockResolvedValue(config);

      await expect(client.queryConfig()).rejects.toThrow("node down");
      // Still inside the ttl window: a cached rejection would keep the client broken until the ttl elapsed.
      await expect(client.queryConfig()).resolves.toEqual(config);
      expect(signingClient.queryContractSmart).toHaveBeenCalledTimes(2);
    });
  });

  describe("refreshOracleParams", () => {
    it("executes the refresh message with automatic gas", async () => {
      const { client, signingClient } = setup();

      await expect(client.refreshOracleParams()).resolves.toBe("ORDERED_TX_HASH");
      expect(signingClient.execute).toHaveBeenCalledWith(
        PRIVATE_KEY_ADDRESS,
        CONTRACT_ADDRESS,
        { refresh_oracle_params: {} },
        "auto",
      );
    });
  });

  describe("updateFee", () => {
    it("executes the fee update with automatic gas", async () => {
      const { client, signingClient } = setup();

      await expect(client.updateFee("500")).resolves.toBe("ORDERED_TX_HASH");
      expect(signingClient.execute).toHaveBeenCalledWith(
        PRIVATE_KEY_ADDRESS,
        CONTRACT_ADDRESS,
        { update_fee: { new_fee: "500" } },
        "auto",
      );
    });

    it.each(["abc", "-100", "100.5", ""])("rejects the invalid fee %j without broadcasting anything", async (fee) => {
      const { client, signingClient } = setup();

      await expect(client.updateFee(fee)).rejects.toThrow("Invalid fee");
      expect(signingClient.execute).not.toHaveBeenCalled();
    });
  });

  describe("transferAdmin", () => {
    it("executes the admin transfer with automatic gas", async () => {
      const { client, signingClient } = setup();
      const newAdmin = "akash19rl4cm2hmr8afy4kldpxz3fka4jguq0a3mq6x0";

      await expect(client.transferAdmin(newAdmin)).resolves.toBe("ORDERED_TX_HASH");
      expect(signingClient.execute).toHaveBeenCalledWith(
        PRIVATE_KEY_ADDRESS,
        CONTRACT_ADDRESS,
        { transfer_admin: { new_admin: newAdmin } },
        "auto",
      );
    });

    it.each(["not-a-valid-address", "", "cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu"])(
      "rejects the invalid admin address %j without broadcasting anything",
      async (address) => {
        const { client, signingClient } = setup();

        await expect(client.transferAdmin(address)).rejects.toThrow("Invalid address format");
        expect(signingClient.execute).not.toHaveBeenCalled();
      },
    );
  });

  /** The surface the service actually uses: the cosmwasm execute/query methods plus the unordered-signing seam. */
  type ContractSigningClient = SigningClient & Pick<SigningCosmWasmClient, "execute" | "queryContractSmart">;

  function setup(input?: Partial<SigningClientServiceConfig>) {
    // Gas simulation for the unordered path runs the real query pipeline, so stub the underlying ABCI query.
    const abciQuery = vi.fn().mockResolvedValue({
      code: 0,
      value: SimulateResponse.encode(SimulateResponse.fromPartial({ gasInfo: { gasUsed: 80_000n, gasWanted: 80_000n } })).finish(),
      height: 1,
    });
    const queryClient = new QueryClient(mock<Comet38Client>({ abciQuery }));

    // Encoding goes through a real registry, but behind a plain delegate: the mock proxies nested objects, and a proxied
    // Registry breaks the internal Map its type lookup relies on.
    const registry = new Registry([...defaultRegistryTypes, ["/cosmwasm.wasm.v1.MsgExecuteContract", MsgExecuteContract]]);

    const signingClient = mock<ContractSigningClient>({
      registry: { encodeAsAny: (message: EncodeObject) => registry.encodeAsAny(message) } as Registry,
      execute: vi.fn().mockResolvedValue(mock<ExecuteResult>({ transactionHash: "ORDERED_TX_HASH", gasUsed: 120_000n, gasWanted: 180_000n })),
      queryContractSmart: vi.fn().mockResolvedValue({}),
      getChainId: vi.fn().mockResolvedValue("akashnet-2"),
      getAccount: vi.fn().mockResolvedValue({ address: PRIVATE_KEY_ADDRESS, accountNumber: 7, sequence: 3, pubkey: null } satisfies Account),
      forceGetQueryClient: vi.fn(() => queryClient),
      broadcastTx: vi.fn().mockResolvedValue(mock<DeliverTxResponse>({ code: 0, transactionHash: "UNORDERED_TX_HASH", gasUsed: 90_000n })),
    });

    const connectWithSigner = vi.fn<SigningClientServiceConfig["connectWithSigner"] & object>(
      async () => signingClient as unknown as SigningCosmWasmClient,
    );

    const client = new ContractClientService({
      rpcEndpoint: RPC_ENDPOINT,
      contractAddress: CONTRACT_ADDRESS,
      denom: "uakt",
      gasPrice: "0.025uakt",
      gasMultiplier: 1.5,
      walletSecret: { type: "privateKey", value: PRIVATE_KEY },
      priceUpdateTxMethod: "ordered",
      unorderedTxTtlMs: 180_000,
      smartContractConfigCacheTTLMs: 60_000,
      ...input,
      connectWithSigner,
    });

    const priceUpdate: PriceUpdate = {
      priceData: {
        id: "feed-id",
        price: { price: "12345", conf: "10", expo: -8, publish_time: 1_700_000_000 },
        ema_price: { price: "12345", conf: "10", expo: -8, publish_time: 1_700_000_000 },
      },
      vaa: btoa("vaa-payload"),
    };

    return { client, signingClient, connectWithSigner, abciQuery, priceUpdate };
  }

  function createConfigResponse(): ConfigResponse {
    return {
      admin: MNEMONIC_ADDRESS,
      pyth_vaa_contract: CONTRACT_ADDRESS,
      update_fee: "250",
      price_feed_id: "feed-id",
      default_denom: "uakt",
      default_base_denom: "akt",
    };
  }
});
