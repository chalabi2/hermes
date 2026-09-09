import { z } from "zod";
import { HermesClient, type HermesConfig } from "../services/hermes-client/hermes-client.ts";
import { validateContractAddress, validateWalletSecret } from "../validation.ts";
import type { PriceProducerFactoryOptions } from "../types.ts";
import { pollPriceStream } from "../price-stream/polling-price-stream/polling-price-stream.ts";
import { priceSSEStream } from "../price-stream/price-sse-stream/price-sse-stream.ts";
import { ContractClientService, type SigningClientServiceConfig } from "../services/contract-client/contract-client.service.ts";
import { DEFAULT_HERMES_ENDPOINT, RouterSetUpdater } from "../services/router-set-updater/router-set-updater.ts";

export interface CommandConfig extends HermesConfig {
  createHermesClient: (config: HermesConfig) => HermesClient;
  createContractClient: (config: SigningClientServiceConfig) => ContractClientService;
  signal: AbortSignal;
  healthcheckPort: number;
  insufficientBalanceRetryDelayMs: number;
  rawConfig: z.infer<typeof configSchema>;
}

const configSchema = z.object({
  RPC_ENDPOINT: z.url().default("https://rpc.akashnet.net:443"),
  HERMES_ENDPOINT: z.url().default(DEFAULT_HERMES_ENDPOINT),
  HERMES_API_KEY: z.string().nonempty(),
  CONTRACT_ADDRESS: z.string().nonempty().superRefine(propagateError(validateContractAddress)),
  WALLET_SECRET: z.string()
    .regex(/^(mnemonic|privateKey):.+$/, { message: 'must be in the format "mnemonic:<12/24 word phrase>" or "privateKey:<hex format>"' })
    .transform((rawValue) => {
      const [type, value] = rawValue.split(":", 2);
      return { type: type as "mnemonic" | "privateKey", value };
    })
    .superRefine(propagateError(validateWalletSecret)),
  PRICE_DEVIATION_TOLERANCE: z.string().regex(/^\d+(\.\d+)?%?$/).transform((deviation): CommandConfig["priceDeviationTolerance"] => {
    return deviation.endsWith("%")
      ? { type: "percentage", value: parseFloat(deviation.slice(0, -1)) }
      : { type: "absolute", value: parseFloat(deviation) };
  }).superRefine((deviation, ctx) => {
    if (!deviation) return;
    if (deviation.type === "percentage" && (deviation.value < 0 || deviation.value > 100)) {
      ctx.addIssue({
        code: "custom",
        message: "Percentage deviation must be between 0 and 100",
      });
    }
    if (deviation.type === "absolute" && deviation.value < 0) {
      ctx.addIssue({
        code: "custom",
        message: "Absolute deviation must be non-negative",
      });
    }
  }).optional(),
  PRICE_FETCHING_METHOD: z.enum(["polling", "sse"]).default("polling"),
  PRICE_UPDATE_TX_METHOD: z.enum(["ordered", "unordered"]).default("ordered"),
  UNORDERED_TX_TTL_MS: z.coerce.number().int().min(1000).positive().default(180_000),
  UPDATE_INTERVAL_MS: z.coerce.number().int().nonnegative().default(5 * 1000), // Default to 5 seconds
  HEALTHCHECK_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  GAS_PRICE: z.string().regex(/^(\d+)(\.\d+)?uakt$/, { message: 'GAS_PRICE must be a valid number with unit (e.g., "0.025uakt")' }).default("0.025uakt"),
  GAS_MULTIPLIER: z.coerce.number().min(1).default(1.5),
  DENOM: z.string().default("uakt"),
  NODE_ENV: z.enum(["development", "production"]).optional(),
  SMART_CONTRACT_CONFIG_CACHE_TTL_MS: z.coerce.number().int().min(1000).positive().default(60 * 60 * 1000),
  INSUFFICIENT_BALANCE_RETRY_DELAY_MS: z.coerce.number().int().nonnegative().default(60_000),
});

type ParsedConfig = Omit<CommandConfig, "signal" | "logger">;
export type ParseConfigResult = { ok: true; value: ParsedConfig } | { ok: false; error: string };
export function parseConfig(config: Record<string, string | undefined>): ParseConfigResult {
  const result = configSchema.safeParse(config);

  if (!result.success) {
    return { ok: false, error: z.prettifyError(result.error) };
  }

  const unsafeAllowInsecureEndpoints = result.data.NODE_ENV === "development"; // Enforce secure endpoints in production
  let routerSetUpdater: RouterSetUpdater;
  try {
    routerSetUpdater = new RouterSetUpdater({
      endpoint: result.data.HERMES_ENDPOINT,
      authenticationToken: result.data.HERMES_API_KEY,
      unsafeAllowInsecureEndpoints,
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Invalid HERMES_ENDPOINT" };
  }

  const parsedConfig: ParsedConfig = {
    rawConfig: result.data,
    unsafeAllowInsecureEndpoints,
    rpcEndpoint: result.data.RPC_ENDPOINT,
    contractAddress: result.data.CONTRACT_ADDRESS,
    walletSecret: result.data.WALLET_SECRET,
    healthcheckPort: result.data.HEALTHCHECK_PORT,
    gasPrice: result.data.GAS_PRICE,
    gasMultiplier: result.data.GAS_MULTIPLIER,
    denom: result.data.DENOM,
    priceDeviationTolerance: result.data.PRICE_DEVIATION_TOLERANCE,
    smartContractConfigCacheTTLMs: result.data.SMART_CONTRACT_CONFIG_CACHE_TTL_MS,
    insufficientBalanceRetryDelayMs: result.data.INSUFFICIENT_BALANCE_RETRY_DELAY_MS,
    priceUpdateTxMethod: result.data.PRICE_UPDATE_TX_METHOD,
    unorderedTxTtlMs: result.data.UNORDERED_TX_TTL_MS,
    routerSetUpdater,
    priceProducerFactory(options: PriceProducerFactoryOptions) {
      if (result.data.PRICE_FETCHING_METHOD === "sse") {
        return priceSSEStream({
          ...options,
          unsafeAllowInsecureEndpoints,
          baseUrl: result.data.HERMES_ENDPOINT,
          authenticationToken: result.data.HERMES_API_KEY,
        });
      }
      return pollPriceStream({
        ...options,
        unsafeAllowInsecureEndpoints,
        baseUrl: result.data.HERMES_ENDPOINT,
        pollingIntervalMs: result.data.UPDATE_INTERVAL_MS,
        authenticationToken: result.data.HERMES_API_KEY,
      });
    },
    createHermesClient: (cfg: HermesConfig) => new HermesClient(cfg),
    createContractClient: (cfg: SigningClientServiceConfig) => new ContractClientService(cfg),
  };

  return { ok: true, value: parsedConfig };
}

function propagateError<T>(fn: (value: T) => unknown) {
  return (value: T, ctx: z.core.$RefinementCtx<unknown>) => {
    try {
      fn(value);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: (error as Error).message,
      });
    }
  };
}
