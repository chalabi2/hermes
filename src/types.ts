// Pyth price data from Hermes API
export interface PythPriceData {
  id: string;
  price: {
    price: string;
    conf: string;
    expo: number;
    publish_time: number;
  };
  ema_price: {
    price: string;
    conf: string;
    expo: number;
    publish_time: number;
  };
}

export interface PriceUpdate {
  priceData: PythPriceData;
  // PNAU update data from the upgraded Pyth Hermes API.
  vaa: string;
}

export type PriceProducerFactory = (options: PriceProducerFactoryOptions) => AsyncGenerator<PriceUpdate, void, unknown>;
export interface PriceProducerFactoryOptions {
  priceFeedId: string;
  signal?: AbortSignal;
  logger?: Logger;
}

export type Logger = Pick<Console, "log" | "error" | "warn">;

// Hermes API response with VAA binary data
export interface HermesResponse {
  binary: {
    // Base64 encoded VAA data array
    data: string[];
  };
  parsed: PythPriceData[];
}

export interface PriceUpdater {
  updatePrice: (priceUpdate: PriceUpdate, options: PriceUpdateOptions) => Promise<{
    transactionHash: string;
    gasUsed?: bigint;
  }>;
}

export interface PriceUpdateOptions {
  updateFee: string;
}

export interface UpdatePriceFeedMsg {
  update_price_feed: {
    // PNAU data from Pyth Hermes API (base64 encoded Binary).
    vaa: string;
  };
}

export interface SubmitVaaMsg {
  submit_v_a_a: {
    // Router-set upgrade VAA (base64 encoded Binary).
    vaa: string;
  };
}
