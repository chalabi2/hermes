import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { describe, expect, it, vi } from "vitest";

import type { PythVaaConfigResponse } from "../contract-client/contract-client.service.ts";
import { RouterSetUpdater } from "./router-set-updater.ts";

const ROUTER_COUNT = 5;
const ROUTER_ADDRESS_LEN = 20;
const CURRENT_ROUTER_SET_INDEX = 0;
const NEXT_ROUTER_SET_INDEX = 1;
const GOVERNANCE_PAYLOAD_POS = 35;
const VAA_BODY_PAYLOAD_POS = 51;
const VAA_HEADER_LEN = 6;
const VAA_SIGNATURE_LEN = 66;

describe(RouterSetUpdater.name, () => {
  it("assembles a router-set upgrade VAA from quorum signatures", async () => {
    const currentKeys = routerKeys(1);
    const nextKeys = routerKeys(11);
    const body = buildRouterSetUpgradeBody(nextKeys);
    const shares = [2, 0, 4].map(index => buildUpgradeResponse({
      body,
      signingKey: currentKeys[index],
      nextKeys,
    }));
    const fetch = fetchResponses(shares);
    const updater = new RouterSetUpdater({
      endpoints: ["https://router-2.example/v1", "https://router-0.example/v1", "https://router-4.example/v1"],
      authenticationToken: "secret-token",
      fetch,
    });

    const result = await updater.buildUpgradeVaa(buildConfig(currentKeys));

    expect(result).toEqual({
      vaa: expect.any(String),
      currentRouterSetIndex: CURRENT_ROUTER_SET_INDEX,
      newRouterSetIndex: NEXT_ROUTER_SET_INDEX,
      signatureCount: 3,
    });
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://router-2.example/v1/guardian_set_upgrade"),
      { headers: { Authorization: "Bearer secret-token" } },
    );

    const vaa = Buffer.from(result?.vaa ?? "", "base64");
    expect(vaa[0]).toBe(1);
    expect(readU32(vaa, 1)).toBe(CURRENT_ROUTER_SET_INDEX);
    expect(vaa[5]).toBe(3);
    expect(vaa[VAA_HEADER_LEN]).toBe(0);
    expect(vaa[VAA_HEADER_LEN + VAA_SIGNATURE_LEN]).toBe(2);
    expect(vaa[VAA_HEADER_LEN + 2 * VAA_SIGNATURE_LEN]).toBe(4);
    expect(vaa.subarray(VAA_HEADER_LEN + 3 * VAA_SIGNATURE_LEN)).toEqual(Buffer.from(body));
  });

  it("returns undefined when routers report no upgrade in progress", async () => {
    const updater = new RouterSetUpdater({
      endpoints: ["https://router-0.example/v1", "https://router-1.example/v1", "https://router-2.example/v1"],
      fetch: fetchResponses([null, null, null]),
    });

    await expect(updater.buildUpgradeVaa(buildConfig(routerKeys(1)))).resolves.toBeUndefined();
  });

  it("rejects an upgrade when fewer than three configured routers signed it", async () => {
    const currentKeys = routerKeys(1);
    const nextKeys = routerKeys(11);
    const body = buildRouterSetUpgradeBody(nextKeys);
    const updater = new RouterSetUpdater({
      endpoints: ["https://router-0.example/v1", "https://router-1.example/v1", "https://router-2.example/v1"],
      fetch: fetchResponses([
        buildUpgradeResponse({ body, signingKey: currentKeys[0], nextKeys }),
        null,
        null,
      ]),
    });

    await expect(updater.buildUpgradeVaa(buildConfig(currentKeys))).rejects.toThrow(
      "only had 1 valid signatures",
    );
  });

  it("rejects signatures from routers not in pyth_vaa config", async () => {
    const currentKeys = routerKeys(1);
    const outsiderKeys = routerKeys(31);
    const nextKeys = routerKeys(11);
    const body = buildRouterSetUpgradeBody(nextKeys);
    const updater = new RouterSetUpdater({
      endpoints: ["https://router-0.example/v1", "https://router-1.example/v1", "https://router-2.example/v1"],
      fetch: fetchResponses([0, 1, 2].map(index => buildUpgradeResponse({
        body,
        signingKey: outsiderKeys[index],
        nextKeys,
      }))),
    });

    await expect(updater.buildUpgradeVaa(buildConfig(currentKeys))).rejects.toThrow(
      "does not match any configured router",
    );
  });

  it("accepts signatures encoded as v-r-s and normalizes them for the contract", async () => {
    const currentKeys = routerKeys(1);
    const nextKeys = routerKeys(11);
    const body = buildRouterSetUpgradeBody(nextKeys);
    const shares = [0, 1, 2].map(index => buildUpgradeResponse({
      body,
      signingKey: currentKeys[index],
      nextKeys,
      signatureFormat: "vrs",
    }));
    const updater = new RouterSetUpdater({
      endpoints: ["https://router-0.example/v1", "https://router-1.example/v1", "https://router-2.example/v1"],
      fetch: fetchResponses(shares),
    });

    const result = await updater.buildUpgradeVaa(buildConfig(currentKeys));
    const vaa = Buffer.from(result?.vaa ?? "", "base64");
    const firstSignatureStart = VAA_HEADER_LEN + 1;

    expect(vaa[firstSignatureStart + 64]).toBeLessThanOrEqual(1);
  });

  it("requires an upgrade VAA for the contract's active router set index", async () => {
    const currentKeys = routerKeys(1);
    const nextKeys = routerKeys(11);
    const body = buildRouterSetUpgradeBody(nextKeys, 10);
    const response = buildUpgradeResponse({
      body,
      signingKey: currentKeys[0],
      nextKeys,
      currentRouterSetIndex: 9,
      newRouterSetIndex: 10,
    });
    const updater = new RouterSetUpdater({
      endpoints: ["https://router-0.example/v1", "https://router-1.example/v1", "https://router-2.example/v1"],
      fetch: fetchResponses([response, response, response]),
    });

    await expect(updater.buildUpgradeVaa(buildConfig(currentKeys))).rejects.toThrow(
      "No router set upgrade VAA found for current router set index 0",
    );
  });
});

function routerKeys(offset: number): Uint8Array[] {
  return Array.from({ length: ROUTER_COUNT }, (_, index) => {
    const key = new Uint8Array(32);
    key.fill(index + offset);
    return key;
  });
}

function buildConfig(keys: Uint8Array[]): PythVaaConfigResponse {
  return {
    admin: "akash1admin",
    governance_target_chain: 0,
    router_verifier: {
      router_set_index: CURRENT_ROUTER_SET_INDEX,
      routers: keys.map(key => ({ bytes: Buffer.from(routerAddress(key)).toString("base64") })),
      expected_emitter_chain: 26,
      expected_emitter_address: Buffer.from("PythnetPythnetPythnetPythnetPyth").toString("base64"),
    },
  };
}

function buildRouterSetUpgradeBody(nextKeys: Uint8Array[], routerSetIndex = NEXT_ROUTER_SET_INDEX): Uint8Array {
  const body = new Uint8Array(VAA_BODY_PAYLOAD_POS + GOVERNANCE_PAYLOAD_POS + 5 + ROUTER_COUNT * ROUTER_ADDRESS_LEN);
  writeU32(body, 0, 1_700_000_000);
  writeU32(body, 4, 0);
  writeU16(body, 8, 26);
  body.set(Buffer.from("PythnetPythnetPythnetPythnetPyth"), 10);
  writeU64(body, 42, 1n);
  body[50] = 0;

  const module = Buffer.from("Core");
  body.set(module, VAA_BODY_PAYLOAD_POS + 32 - module.length);
  body[VAA_BODY_PAYLOAD_POS + 32] = 2;
  writeU16(body, VAA_BODY_PAYLOAD_POS + 33, 0);

  const updateStart = VAA_BODY_PAYLOAD_POS + GOVERNANCE_PAYLOAD_POS;
  writeU32(body, updateStart, routerSetIndex);
  body[updateStart + 4] = ROUTER_COUNT;
  nextKeys.forEach((key, index) => {
    body.set(routerAddress(key), updateStart + 5 + index * ROUTER_ADDRESS_LEN);
  });

  return body;
}

function buildUpgradeResponse(input: {
  body: Uint8Array;
  signingKey: Uint8Array;
  nextKeys: Uint8Array[];
  currentRouterSetIndex?: number;
  newRouterSetIndex?: number;
  signatureFormat?: "rsv" | "vrs";
}) {
  const hash = keccak_256(keccak_256(input.body));
  const signature = secp256k1.sign(hash, input.signingKey, {
    prehash: false,
    lowS: false,
    format: "recovered",
  });
  const compact = signature.toBytes("compact");
  const recovery = Uint8Array.of(signature.recovery);
  const rawSignature = input.signatureFormat === "vrs"
    ? concatBytes(recovery, compact)
    : concatBytes(compact, recovery);

  return {
    current_guardian_set_index: input.currentRouterSetIndex ?? CURRENT_ROUTER_SET_INDEX,
    new_guardian_set_index: input.newRouterSetIndex ?? NEXT_ROUTER_SET_INDEX,
    new_guardian_keys: input.nextKeys.map(key => Array.from(routerAddress(key))),
    body: `0x${Buffer.from(input.body).toString("hex")}`,
    signature: `0x${Buffer.from(rawSignature).toString("hex")}`,
  };
}

function routerAddress(secretKey: Uint8Array): Uint8Array {
  const publicKey = secp256k1.getPublicKey(secretKey, false);
  return keccak_256(publicKey.subarray(1)).subarray(12);
}

function fetchResponses(responses: Array<unknown>): typeof fetch {
  const fetch = vi.fn(async () => {
    const response = responses.shift();
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  return fetch;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

function writeU16(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset + offset, 2).setUint16(0, value, false);
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset + offset, 4).setUint32(0, value, false);
}

function writeU64(bytes: Uint8Array, offset: number, value: bigint): void {
  new DataView(bytes.buffer, bytes.byteOffset + offset, 8).setBigUint64(0, value, false);
}
