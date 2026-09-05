import type { CommandConfig } from "../command-config.ts";

export interface QueryOptions {
  feed?: boolean;
  config?: boolean;
  oracleParams?: boolean;
}

export async function queryCommand(config: CommandConfig, options: QueryOptions): Promise<void> {
  const client = config.createContractClient(config);

  if (options.config) {
    config.logger?.log("Contract Configuration:\n");
    const cfg = await client.queryConfig();
    config.logger?.log("─────────────────────────────");
    config.logger?.log(`Admin:            ${cfg.admin}`);
    config.logger?.log(`Update Fee:       ${cfg.update_fee}`);
    config.logger?.log(`Price Feed ID:    ${cfg.price_feed_id}`);
    config.logger?.log(`Pyth VAA:         ${cfg.pyth_vaa_contract}`);
    config.logger?.log(`Default Denom:    ${cfg.default_denom}`);
    config.logger?.log(`Base Denom:       ${cfg.default_base_denom}`);
    return;
  }

  if (options.oracleParams) {
    config.logger?.log("Cached Oracle Parameters:\n");
    const params = await client.queryOracleParams();
    config.logger?.log("─────────────────────────────");
    config.logger?.log(`Max Deviation:    ${params.max_price_deviation_bps} bps (${params.max_price_deviation_bps / 100}%)`);
    config.logger?.log(`Min Sources:      ${params.min_price_sources}`);
    config.logger?.log(`Max Staleness:    ${params.max_price_staleness_blocks} blocks`);
    config.logger?.log(`TWAP Window:      ${params.twap_window} blocks`);
    config.logger?.log(`Last Updated:     Height ${params.last_updated_height}`);
    return;
  }

  if (options.feed) {
    config.logger?.log("Price Feed Data:\n");
    const feed = await client.queryPriceFeed();
    config.logger?.log("─────────────────────────────");
    config.logger?.log(`Symbol:           ${feed.symbol}`);
    config.logger?.log(`Price:            ${feed.price}`);
    config.logger?.log(`Confidence:       ${feed.conf}`);
    config.logger?.log(`Exponent:         ${feed.expo}`);
    config.logger?.log(`Publish Time:     ${feed.publish_time}`);
    config.logger?.log(`                  ${new Date(feed.publish_time * 1000).toISOString()}`);
    config.logger?.log(`Prev Publish:     ${feed.prev_publish_time}`);
    config.logger?.log(`                  ${new Date(feed.prev_publish_time * 1000).toISOString()}`);

    // Calculate human-readable price
    const humanPrice = parseInt(feed.price, 10) / Math.pow(10, Math.abs(feed.expo));
    const humanConf = parseInt(feed.conf, 10) / Math.pow(10, Math.abs(feed.expo));
    config.logger?.log("\nFormatted:");
    config.logger?.log(`Price:            $${humanPrice.toFixed(8)} +/- $${humanConf.toFixed(8)}`);
    return;
  }

  // Default: query current price
  config.logger?.log("Current Price:\n");
  const price = await client.queryCurrentPrice();

  config.logger?.log("─────────────────────────────");
  config.logger?.log(`Price:        ${price.price}`);
  config.logger?.log(`Confidence:   ${price.conf}`);
  config.logger?.log(`Exponent:     ${price.expo}`);
  config.logger?.log(`Publish Time: ${price.publish_time}`);
  config.logger?.log(`              ${new Date(price.publish_time * 1000).toISOString()}`);

  // Calculate human-readable price
  const humanPrice = parseInt(price.price, 10) / Math.pow(10, Math.abs(price.expo));
  const humanConf = parseInt(price.conf, 10) / Math.pow(10, Math.abs(price.expo));
  config.logger?.log("\nFormatted:");
  config.logger?.log(`Price:        $${humanPrice.toFixed(8)} +/- $${humanConf.toFixed(8)}`);

  // Check staleness
  const now = Math.floor(Date.now() / 1000);
  const age = now - price.publish_time;
  config.logger?.log(`\nAge:          ${age} seconds`);

  if (age > 300) {
    config.logger?.log("Warning: Price data is stale (>5 minutes old)");
  } else {
    config.logger?.log("Price data is fresh");
  }
}
