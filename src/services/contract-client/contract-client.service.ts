import { SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { toUtf8 } from "@cosmjs/encoding";
import { type AccountData, DirectSecp256k1HdWallet, DirectSecp256k1Wallet, type EncodeObject, type OfflineDirectSigner } from "@cosmjs/proto-signing";
import { GasPrice, type DeliverTxResponse } from "@cosmjs/stargate";
import { TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { MsgExecuteContract } from "cosmjs-types/cosmwasm/wasm/v1/tx";
import { memoizeAsync } from "../../lib/caching/helpers/helpers.ts";
import { type SigningClient, SigningStargateClientService } from "../../lib/signing-stargate-client/signing-stargate-client.service.ts";
import type { PriceUpdate, PriceUpdateOptions, PriceUpdater, SubmitVaaMsg, UpdatePriceFeedMsg } from "../../types.ts";
import { validateAkashAddress, validateContractAddress, validateFeeAmount } from "../../validation.ts";

export class ContractClientService implements PriceUpdater {
  readonly #config: SigningClientServiceConfig;

  #smartContractConfig: {
    expiresAt: number;
    value?: Promise<ConfigResponse>;
  } = { expiresAt: 0 };

  constructor(config: SigningClientServiceConfig) {
    this.#config = config;
  }

  #getSigner = memoizeAsync(async () => {
    return await this.#createWallet(this.#config.walletSecret);
  });

  #getSigningClient = memoizeAsync(async () => {
    const connectWithSigner = this.#config.connectWithSigner ?? SigningCosmWasmClient.connectWithSigner;
    return await connectWithSigner(
      this.#config.rpcEndpoint,
      await this.#getSigner(),
      { gasPrice: GasPrice.fromString(this.#config.gasPrice) },
    );
  });

  #getSigningClientWithUnorderedTxSupport = memoizeAsync(async () => {
    const [signingClient, signer] = await Promise.all([
      this.#getSigningClient(),
      this.#getSigner(),
    ]);
    return new SigningStargateClientService(signingClient as unknown as SigningClient, signer, {
      ttlMs: this.#config.unorderedTxTtlMs,
      gasMultiplier: this.#config.gasMultiplier,
      averageGasPrice: parseFloat(this.#config.gasPrice),
    });
  });

  async getAccount(): Promise<AccountData> {
    const signer = await this.#getSigner();
    const [accountData] = await signer.getAccounts();
    if (!accountData) {
      throw new Error("No accounts found in signer");
    }

    return accountData;
  }

  async updatePrice(priceUpdate: PriceUpdate, options: PriceUpdateOptions): Promise<{
    transactionHash: string;
    gasUsed?: bigint;
  }> {
    const msg: UpdatePriceFeedMsg = {
      update_price_feed: {
        vaa: priceUpdate.vaa,
      },
    };

    if (this.#config.priceUpdateTxMethod === "unordered") {
      return await this.#executeInUnorderedTx({
        contractAddress: this.#config.contractAddress,
        msg,
        funds: [{ denom: this.#config.denom, amount: options.updateFee }],
      });
    }

    return await this.#executeInOrderedTx({
      contractAddress: this.#config.contractAddress,
      msg,
      funds: [{ denom: this.#config.denom, amount: options.updateFee }],
    });
  }

  async submitRouterSetUpgrade(input: {
    pythVaaContract: string;
    vaa: string;
  }): Promise<{
    transactionHash: string;
    gasUsed?: bigint;
  }> {
    validateContractAddress(input.pythVaaContract);

    const msg: SubmitVaaMsg = {
      submit_v_a_a: {
        vaa: input.vaa,
      },
    };

    if (this.#config.priceUpdateTxMethod === "unordered") {
      return await this.#executeInUnorderedTx({
        contractAddress: input.pythVaaContract,
        msg,
      });
    }

    return await this.#executeInOrderedTx({
      contractAddress: input.pythVaaContract,
      msg,
    });
  }

  async #executeInUnorderedTx(input: {
    contractAddress: string;
    msg: ContractExecuteMsg;
    funds?: ContractFunds;
  }) {
    const [signingClient, account] = await Promise.all([
      this.#getSigningClientWithUnorderedTxSupport(),
      this.getAccount(),
    ]);

    const messages: EncodeObject[] = [
      {
        typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
        value: MsgExecuteContract.fromPartial({
          sender: account.address,
          contract: input.contractAddress,
          msg: toUtf8(JSON.stringify(input.msg)),
          funds: input.funds ?? [],
        }),
      },
    ];

    const tx = await signingClient.signUnordered(messages);
    const deliveredTx = await signingClient.broadcastTx(TxRaw.encode(tx).finish());
    if (deliveredTx.code !== 0) {
      throw new BroadcastError(deliveredTx);
    }
    return {
      transactionHash: deliveredTx.transactionHash,
      gasUsed: BigInt(deliveredTx.gasUsed),
    };
  }

  async #executeInOrderedTx(input: {
    contractAddress: string;
    msg: ContractExecuteMsg;
    funds?: ContractFunds;
  }) {
    const [signingClient, account] = await Promise.all([
      this.#getSigningClient(),
      this.getAccount(),
    ]);
    const result = await signingClient.execute(
      account.address,
      input.contractAddress,
      input.msg,
      this.#config.gasMultiplier,
      undefined,
      input.funds,
    );
    return {
      transactionHash: result.transactionHash,
      gasUsed: result.gasUsed,
    };
  }

  #createWallet(secret: SigningClientServiceConfig["walletSecret"]): Promise<OfflineDirectSigner> {
    const prefix = "akash";
    if (secret.type === "mnemonic") {
      return DirectSecp256k1HdWallet.fromMnemonic(secret.value, { prefix });
    }

    const privateKeyBytes = Buffer.from(secret.value, "hex");
    return DirectSecp256k1Wallet.fromKey(privateKeyBytes, prefix);
  }

  async queryCurrentPrice(): Promise<PriceResponse> {
    const signingClient = await this.#getSigningClient();
    const price: PriceResponse = await signingClient.queryContractSmart(
      this.#config.contractAddress,
      { get_price: {} },
    );

    return price;
  }

  async queryPriceFeed(): Promise<PriceFeedResponse> {
    const signingClient = await this.#getSigningClient();
    const feed: PriceFeedResponse = await signingClient.queryContractSmart(
      this.#config.contractAddress,
      { get_price_feed: {} },
    );

    return feed;
  }

  async queryConfig(): Promise<ConfigResponse> {
    if (!this.#smartContractConfig.value || Date.now() > this.#smartContractConfig.expiresAt) {
      this.#smartContractConfig.expiresAt = Date.now() + this.#config.smartContractConfigCacheTTLMs;
      this.#smartContractConfig.value = this.#getSigningClient()
        .then(signingClient => signingClient.queryContractSmart(
          this.#config.contractAddress,
          { get_config: {} },
        )).catch((error) => {
          this.#smartContractConfig.value = undefined;
          this.#smartContractConfig.expiresAt = 0;
          throw error;
        });
    }

    const config = await this.#smartContractConfig.value;
    return config;
  }

  async queryPythVaaConfig(pythVaaContract: string): Promise<PythVaaConfigResponse> {
    validateContractAddress(pythVaaContract);
    const signingClient = await this.#getSigningClient();
    const config: PythVaaConfigResponse = await signingClient.queryContractSmart(
      pythVaaContract,
      { get_config: {} },
    );

    return config;
  }

  async queryOracleParams(): Promise<OracleParamsResponse> {
    const signingClient = await this.#getSigningClient();
    const params: OracleParamsResponse = await signingClient.queryContractSmart(
      this.#config.contractAddress,
      { get_oracle_params: {} },
    );

    return params;
  }

  async refreshOracleParams(): Promise<string> {
    const msg: RefreshOracleParamsMsg = {
      refresh_oracle_params: {},
    };

    const [signingClient, account] = await Promise.all([
      this.#getSigningClient(),
      this.getAccount(),
    ]);
    const result = await signingClient.execute(
      account.address,
      this.#config.contractAddress,
      msg,
      "auto",
    );

    return result.transactionHash;
  }

  async updateFee(newFee: string): Promise<string> {
    validateFeeAmount(newFee);

    const msg: UpdateFeeMsg = {
      update_fee: {
        new_fee: newFee,
      },
    };

    const [signingClient, account] = await Promise.all([
      this.#getSigningClient(),
      this.getAccount(),
    ]);
    const result = await signingClient.execute(
      account.address,
      this.#config.contractAddress,
      msg,
      "auto",
    );

    return result.transactionHash;
  }

  async transferAdmin(newAdmin: string): Promise<string> {
    validateAkashAddress(newAdmin);

    const msg: TransferAdminMsg = {
      transfer_admin: {
        new_admin: newAdmin,
      },
    };

    const [signingClient, account] = await Promise.all([
      this.#getSigningClient(),
      this.getAccount(),
    ]);
    const result = await signingClient.execute(
      account.address,
      this.#config.contractAddress,
      msg,
      "auto",
    );

    return result.transactionHash;
  }

  async disconnect(): Promise<void> {
    const signingClient = await this.#getSigningClient();
    this.#getSigningClient.cache.clear();
    this.#getSigningClientWithUnorderedTxSupport.cache.clear();
    signingClient.disconnect();
  }
}

/**
 * A tx the node accepted into a block but that failed while executing: it is on chain, it spent its fee, and it changed
 * nothing. Distinct from a rejected broadcast, which never lands and throws out of `broadcastTx` itself.
 *
 * The `code` alone is not diagnosable, because every module numbers its own errors starting at 2 and the codespace that
 * disambiguates them is dropped by cosmjs when it maps the indexed tx to a `DeliverTxResponse`. Code 5 is `insufficient
 * funds` under the `sdk` codespace but `execute wasm contract failed` under `wasm`. What the chain does report is
 * `rawLog`, the module's own error text, so carry that plus the hash needed to look the tx up on chain.
 */
export class BroadcastError extends Error {
  readonly code: number;

  readonly rawLog: string;

  readonly transactionHash: string;

  constructor(deliveredTx: Pick<DeliverTxResponse, "code" | "rawLog" | "transactionHash">) {
    const rawLog = deliveredTx.rawLog ?? "";
    const detail = rawLog || "chain returned no log; query the tx by hash for the module error";
    super(`Broadcast failed with code ${deliveredTx.code} (tx ${deliveredTx.transactionHash}): ${detail}`);
    this.name = "BroadcastError";
    this.code = deliveredTx.code;
    this.rawLog = rawLog;
    this.transactionHash = deliveredTx.transactionHash;
  }
}

export interface SigningClientServiceConfig {
  rpcEndpoint: string;
  contractAddress: string;
  denom: string;
  gasPrice: string;
  gasMultiplier: number;
  walletSecret:
    | {
      type: "mnemonic";
      /** mnemonic phrase for wallet */
      value: string;
    }
    | {
      type: "privateKey";
      /** hex-encoded private key for wallet */
      value: string;
    };
  priceUpdateTxMethod?: "ordered" | "unordered";
  unorderedTxTtlMs: number;
  smartContractConfigCacheTTLMs: number;
  /**
   * Seam for establishing the RPC connection.
   * @default SigningCosmWasmClient.connectWithSigner
   */
  connectWithSigner?: typeof SigningCosmWasmClient.connectWithSigner;
}

export interface ConfigResponse {
  admin: string;
  pyth_vaa_contract: string;
  update_fee: string;       // Uint256 serializes as string
  price_feed_id: string;
  default_denom: string;
  default_base_denom: string;
}

export interface PriceResponse {
  price: string;            // Uint128 serializes as string
  conf: string;             // Uint128 serializes as string
  expo: number;             // i32
  publish_time: number;     // i64
}

interface UpdateFeeMsg {
  update_fee: {
    new_fee: string;      // Uint256 serializes as string in JSON
  };
}

interface TransferAdminMsg {
  transfer_admin: {
    new_admin: string;
  };
}

interface RefreshOracleParamsMsg {
  refresh_oracle_params: Record<string, never>;
}

interface PriceFeedResponse {
  symbol: string;
  price: string;            // Uint128 serializes as string
  conf: string;             // Uint128 serializes as string
  expo: number;             // i32
  publish_time: number;     // i64
  prev_publish_time: number; // i64
}

interface OracleParamsResponse {
  max_price_deviation_bps: number;    // u64
  min_price_sources: number;          // u32
  max_price_staleness_blocks: number; // i64
  twap_window: number;                // i64
  last_updated_height: number;        // u64
}

export interface PythVaaConfigResponse {
  admin: string;
  governance_target_chain: number;
  router_verifier: {
    router_set_index: number;
    routers: Array<{ bytes: string }>;
    expected_emitter_chain: number;
    expected_emitter_address: string;
  };
}

type ContractExecuteMsg = UpdatePriceFeedMsg | SubmitVaaMsg;
type ContractFunds = Array<{ denom: string; amount: string }>;
