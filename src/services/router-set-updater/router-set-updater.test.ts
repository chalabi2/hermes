import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { describe, expect, it, vi } from "vitest";

import type { PythVaaConfigResponse } from "../contract-client/contract-client.service.ts";
import { RouterSetUpdater } from "./router-set-updater.ts";
import productionRouterUpgrades from "./fixtures/production-router-upgrades.json" with { type: "json" };

const ROUTER_COUNT = 5;
const ROUTER_ADDRESS_LEN = 20;
const CURRENT_ROUTER_SET_INDEX = 0;
const NEXT_ROUTER_SET_INDEX = 1;
const VAA_HEADER_LEN = 6;
const VAA_SIGNATURE_LEN = 66;
const VAA_BODY_PAYLOAD_POS = 51;
const GOVERNANCE_PAYLOAD_POS = 35;
const AKASH_TARGET_CHAIN = 29;
const PYTHNET_EMITTER_CHAIN = 26;
const PYTHNET_EMITTER_ADDRESS = Buffer.from("PythnetPythnetPythnetPythnetPyth");
const GOVERNANCE_EMITTER_CHAIN = 1;
const GOVERNANCE_EMITTER_ADDRESS = Buffer.from(
  "0000000000000000000000000000000000000000000000000000000000000004",
  "hex",
);

// Original set-0 addresses from akash-node/tests/e2e/pyth_contract_test.go.
const PRODUCTION_CONFIG: PythVaaConfigResponse = {
  admin: "akash1admin",
  governance_target_chain: AKASH_TARGET_CHAIN,
  router_verifier: {
    router_set_index: CURRENT_ROUTER_SET_INDEX,
    routers: [
      "41534bb176e461a3fb30479400f210549ecce638",
      "6502987b62f21cab7eb5ccd8f0173084b60d5b41",
      "44a3e8f6a382412cf6bb90a3f8106e68977476c9",
      "d9d7d4529577864352c9a6539a48238fcd447052",
      "1663a5a822336ece48559b1dfb1e93a017a7dac3",
    ].map(address => ({ bytes: Buffer.from(address, "hex").toString("base64") })),
    expected_emitter_chain: PYTHNET_EMITTER_CHAIN,
    expected_emitter_address: PYTHNET_EMITTER_ADDRESS.toString("base64"),
  },
};

describe(RouterSetUpdater.name, () => {
  it("accepts the unchanged published production governance VAA with the configured price emitter", async () => {
    // Unmodified upstream fixture, including its four original signatures:
    // https://github.com/pyth-network/pyth-crosschain/blob/main/contract_manager/src/store/guardian_sets/ProCompatibleProductionGuardianSetVaas.json
    const published = productionRouterUpgrades[0];
    const vaa = Buffer.from(published.vaa, "hex");
    const config = structuredClone(PRODUCTION_CONFIG);
    const updater = updaterForVaa(vaa);

    const result = await updater.buildUpgradeVaa(config);

    expect(result).toEqual({
      vaa: vaa.toString("base64"),
      currentRouterSetIndex: CURRENT_ROUTER_SET_INDEX,
      newRouterSetIndex: published.guardianSetIndex,
      signatureCount: 4,
    });
    expect(result && Buffer.from(result.vaa, "base64").toString("hex")).toBe(published.vaa);
    expect(config).toEqual(PRODUCTION_CONFIG);
  });

  it.each([
    { part: "signature", offset: VAA_HEADER_LEN + 1 },
    { part: "body", offset: VAA_HEADER_LEN + 4 * VAA_SIGNATURE_LEN },
  ])("rejects a tampered published VAA $part", async ({ offset }) => {
    const vaa = Buffer.from(productionRouterUpgrades[0].vaa, "hex");
    vaa[offset] ^= 1;

    await expect(updaterForVaa(vaa).buildUpgradeVaa(PRODUCTION_CONFIG)).rejects.toThrow(
      "signature does not match any configured router",
    );
  });

  it("rejects replay of the published VAA after the active router set advances", async () => {
    const vaa = Buffer.from(productionRouterUpgrades[0].vaa, "hex");
    const config = structuredClone(PRODUCTION_CONFIG);
    config.router_verifier.router_set_index = NEXT_ROUTER_SET_INDEX;

    await expect(updaterForVaa(vaa).buildUpgradeVaa(config)).rejects.toThrow(
      "No router set upgrade VAA found for current router set index 1",
    );
  });

  it("fetches the documented Hermes upgrade VAA and returns base64 bytes for submit_v_a_a", async () => {
    const currentKeys = routerKeys(1);
    const nextKeys = routerKeys(11);
    const vaa = buildRouterSetUpgradeVaa({ currentKeys, nextKeys });
    const fetch = fetchResponse({ vaa: `0x${Buffer.from(vaa).toString("hex")}` });
    const updater = new RouterSetUpdater({
      endpoint: "https://pyth.example/hermes",
      authenticationToken: "secret-token",
      fetch,
    });

    const result = await updater.buildUpgradeVaa(buildConfig(currentKeys));

    expect(fetch).toHaveBeenCalledWith(
      new URL("https://pyth.example/hermes/v1/guardian_set_upgrade_vaa"),
      { headers: { Authorization: "Bearer secret-token" } },
    );
    expect(result).toEqual({
      vaa: Buffer.from(vaa).toString("base64"),
      currentRouterSetIndex: CURRENT_ROUTER_SET_INDEX,
      newRouterSetIndex: NEXT_ROUTER_SET_INDEX,
      signatureCount: 3,
    });
  });

  it("returns undefined when Hermes reports no guardian set upgrade in progress", async () => {
    const updater = new RouterSetUpdater({
      endpoint: "https://pyth.example/hermes",
      fetch: fetchResponse("no guardian set upgrade in progress", { status: 404 }),
    });

    await expect(updater.buildUpgradeVaa(buildConfig(routerKeys(1)))).resolves.toBeUndefined();
  });

  it("rejects an upgrade VAA for a different active router set index", async () => {
    const currentKeys = routerKeys(1);
    const nextKeys = routerKeys(11);
    const vaa = buildRouterSetUpgradeVaa({
      currentKeys,
      nextKeys,
      currentRouterSetIndex: 9,
      newRouterSetIndex: 10,
    });
    const updater = updaterForVaa(vaa);

    await expect(updater.buildUpgradeVaa(buildConfig(currentKeys))).rejects.toThrow(
      "No router set upgrade VAA found for current router set index 0",
    );
  });

  it("rejects an upgrade VAA with fewer than quorum signatures", async () => {
    const currentKeys = routerKeys(1);
    const nextKeys = routerKeys(11);
    const vaa = buildRouterSetUpgradeVaa({
      currentKeys,
      nextKeys,
      signerIndexes: [0, 1],
    });
    const updater = updaterForVaa(vaa);

    await expect(updater.buildUpgradeVaa(buildConfig(currentKeys))).rejects.toThrow(
      "only had 2 signatures",
    );
  });

  it.each([CURRENT_ROUTER_SET_INDEX, NEXT_ROUTER_SET_INDEX + 1])(
    "rejects a signed upgrade to nonsequential router set index %i",
    async (newRouterSetIndex) => {
      const currentKeys = routerKeys(1);
      const vaa = buildRouterSetUpgradeVaa({
        currentKeys,
        nextKeys: routerKeys(11),
        newRouterSetIndex,
      });

      await expect(updaterForVaa(vaa).buildUpgradeVaa(buildConfig(currentKeys))).rejects.toThrow(
        "No router set upgrade VAA found for current router set index 0",
      );
    },
  );

  it.each([
    { name: "duplicate", signerIndexes: [0, 0, 1] },
    { name: "out-of-order", signerIndexes: [1, 0, 2] },
  ])("rejects $name signer indices", async ({ signerIndexes }) => {
    const currentKeys = routerKeys(1);
    const vaa = buildRouterSetUpgradeVaa({
      currentKeys,
      nextKeys: routerKeys(11),
      signerIndexes,
    });

    await expect(updaterForVaa(vaa).buildUpgradeVaa(buildConfig(currentKeys))).rejects.toThrow(
      "Invalid Pyth router set upgrade signature order",
    );
  });

  it("rejects signatures from routers not in pyth_vaa config", async () => {
    const currentKeys = routerKeys(1);
    const outsiderKeys = routerKeys(31);
    const nextKeys = routerKeys(11);
    const vaa = buildRouterSetUpgradeVaa({
      currentKeys: outsiderKeys,
      nextKeys,
    });
    const updater = updaterForVaa(vaa);

    await expect(updater.buildUpgradeVaa(buildConfig(currentKeys))).rejects.toThrow(
      "does not match any configured router",
    );
  });

  it("rejects the wrong governance target chain", async () => {
    const currentKeys = routerKeys(1);
    const nextKeys = routerKeys(11);
    const vaa = buildRouterSetUpgradeVaa({
      currentKeys,
      nextKeys,
      governanceTargetChain: AKASH_TARGET_CHAIN + 1,
    });
    const updater = updaterForVaa(vaa);

    await expect(updater.buildUpgradeVaa(buildConfig(currentKeys))).rejects.toThrow(
      "Invalid Pyth router set upgrade governance target chain",
    );
  });

  it.each([
    {
      name: "configured price emitter",
      emitterChain: PYTHNET_EMITTER_CHAIN,
      emitterAddress: PYTHNET_EMITTER_ADDRESS,
    },
    {
      name: "wrong governance emitter chain",
      emitterChain: GOVERNANCE_EMITTER_CHAIN + 1,
      emitterAddress: GOVERNANCE_EMITTER_ADDRESS,
    },
    {
      name: "wrong governance emitter address",
      emitterChain: GOVERNANCE_EMITTER_CHAIN,
      emitterAddress: PYTHNET_EMITTER_ADDRESS,
    },
  ])("rejects a quorum-signed rotation from the $name", async ({ emitterChain, emitterAddress }) => {
    const currentKeys = routerKeys(1);
    const nextKeys = routerKeys(11);
    const vaa = buildRouterSetUpgradeVaa({
      currentKeys,
      nextKeys,
      emitterChain,
      emitterAddress,
    });
    const updater = updaterForVaa(vaa);

    await expect(updater.buildUpgradeVaa(buildConfig(currentKeys))).rejects.toThrow(
      "Invalid Pyth router set upgrade emitter",
    );
  });

  it("rejects duplicate routers in the new set", async () => {
    const currentKeys = routerKeys(1);
    const nextKeys = routerKeys(11);
    nextKeys[4] = nextKeys[3];
    const vaa = buildRouterSetUpgradeVaa({ currentKeys, nextKeys });
    const updater = updaterForVaa(vaa);

    await expect(updater.buildUpgradeVaa(buildConfig(currentKeys))).rejects.toThrow(
      "duplicate router addresses",
    );
  });
});

function updaterForVaa(vaa: Uint8Array): RouterSetUpdater {
  return new RouterSetUpdater({
    endpoint: "https://pyth.example/hermes",
    fetch: fetchResponse({ vaa: Buffer.from(vaa).toString("hex") }),
  });
}

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
    governance_target_chain: AKASH_TARGET_CHAIN,
    router_verifier: {
      router_set_index: CURRENT_ROUTER_SET_INDEX,
      routers: keys.map(key => ({ bytes: Buffer.from(routerAddress(key)).toString("base64") })),
      expected_emitter_chain: PYTHNET_EMITTER_CHAIN,
      expected_emitter_address: PYTHNET_EMITTER_ADDRESS.toString("base64"),
    },
  };
}

function buildRouterSetUpgradeVaa(input: {
  currentKeys: Uint8Array[];
  nextKeys: Uint8Array[];
  currentRouterSetIndex?: number;
  newRouterSetIndex?: number;
  governanceTargetChain?: number;
  emitterChain?: number;
  emitterAddress?: Uint8Array;
  signerIndexes?: number[];
}): Uint8Array {
  const signerIndexes = input.signerIndexes ?? [0, 1, 2];
  const body = buildRouterSetUpgradeBody({
    nextKeys: input.nextKeys,
    routerSetIndex: input.newRouterSetIndex ?? NEXT_ROUTER_SET_INDEX,
    governanceTargetChain: input.governanceTargetChain ?? AKASH_TARGET_CHAIN,
    emitterChain: input.emitterChain ?? GOVERNANCE_EMITTER_CHAIN,
    emitterAddress: input.emitterAddress ?? GOVERNANCE_EMITTER_ADDRESS,
  });
  const hash = keccak_256(keccak_256(body));
  const vaa = new Uint8Array(VAA_HEADER_LEN + signerIndexes.length * VAA_SIGNATURE_LEN + body.length);
  let offset = 0;
  vaa[offset++] = 1;
  writeU32(vaa, offset, input.currentRouterSetIndex ?? CURRENT_ROUTER_SET_INDEX);
  offset += 4;
  vaa[offset++] = signerIndexes.length;

  for (const signerIndex of signerIndexes) {
    vaa[offset++] = signerIndex;
    vaa.set(signContractVaaBytes(input.currentKeys[signerIndex], hash), offset);
    offset += 65;
  }

  vaa.set(body, offset);
  return vaa;
}

function buildRouterSetUpgradeBody(input: {
  nextKeys: Uint8Array[];
  routerSetIndex: number;
  governanceTargetChain: number;
  emitterChain: number;
  emitterAddress: Uint8Array;
}): Uint8Array {
  const body = new Uint8Array(VAA_BODY_PAYLOAD_POS + GOVERNANCE_PAYLOAD_POS + 5 + ROUTER_COUNT * ROUTER_ADDRESS_LEN);
  writeU32(body, 0, 1_700_000_000);
  writeU32(body, 4, 0);
  writeU16(body, 8, input.emitterChain);
  body.set(input.emitterAddress, 10);
  writeU64(body, 42, 1n);
  body[50] = 0;

  const module = Buffer.from("Core");
  body.set(module, VAA_BODY_PAYLOAD_POS + 32 - module.length);
  body[VAA_BODY_PAYLOAD_POS + 32] = 2;
  writeU16(body, VAA_BODY_PAYLOAD_POS + 33, input.governanceTargetChain);

  const updateStart = VAA_BODY_PAYLOAD_POS + GOVERNANCE_PAYLOAD_POS;
  writeU32(body, updateStart, input.routerSetIndex);
  body[updateStart + 4] = ROUTER_COUNT;
  input.nextKeys.forEach((key, index) => {
    body.set(routerAddress(key), updateStart + 5 + index * ROUTER_ADDRESS_LEN);
  });

  return body;
}

function signContractVaaBytes(signingKey: Uint8Array, hash: Uint8Array): Uint8Array {
  const signature = secp256k1.sign(hash, signingKey, {
    prehash: false,
    lowS: false,
    format: "recovered",
  });
  const recovery = signature.hasHighS()
    ? signature.recovery ^ 1
    : signature.recovery;
  const normalized = signature.normalizeS();
  return concatBytes(normalized.toBytes("compact"), Uint8Array.of(recovery));
}

function routerAddress(secretKey: Uint8Array): Uint8Array {
  const publicKey = secp256k1.getPublicKey(secretKey, false);
  return keccak_256(publicKey.subarray(1)).subarray(12);
}

function fetchResponse(body: unknown, init: ResponseInit = {}): typeof fetch {
  return vi.fn(async () => new Response(
    typeof body === "string" ? body : JSON.stringify(body),
    {
      status: init.status ?? 200,
      headers: init.headers ?? { "content-type": "application/json" },
    },
  ));
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

function writeU16(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset + offset, 2).setUint16(0, value, false);
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset + offset, 4).setUint32(0, value, false);
}

function writeU64(bytes: Uint8Array, offset: number, value: bigint): void {
  new DataView(bytes.buffer, bytes.byteOffset + offset, 8).setBigUint64(0, value, false);
}
