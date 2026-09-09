import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { z } from "zod";

import type { PythVaaConfigResponse } from "../contract-client/contract-client.service.ts";
import { validateEndpointUrl } from "../../validation.ts";

export const DEFAULT_HERMES_ENDPOINT = "https://pyth.dourolabs.app/hermes";

const ROUTER_COUNT = 5;
const ROUTER_QUORUM = 3;
const ROUTER_ADDRESS_LEN = 20;
const VAA_VERSION = 1;
const VAA_HEADER_LEN = 6;
const VAA_SIGNATURE_LEN = 66;
const VAA_EMITTER_CHAIN_POS = 8;
const VAA_EMITTER_ADDRESS_POS = 10;
const VAA_EMITTER_ADDRESS_LEN = 32;
const VAA_BODY_PAYLOAD_POS = 51;
const GOVERNANCE_MODULE_LEN = 32;
const GOVERNANCE_ACTION_POS = 32;
const GOVERNANCE_TARGET_CHAIN_POS = 33;
const GOVERNANCE_PAYLOAD_POS = 35;
const GOVERNANCE_ACTION_ROUTER_SET_UPGRADE = 2;
const GOVERNANCE_TARGET_CHAIN_GLOBAL = 0;
const SIGNATURE_LEN = 65;
const COMPACT_SIGNATURE_LEN = 64;
const U32_MAX = 0xffffffff;

const guardianSetUpgradeVaaSchema = z.object({
  vaa: z.string(),
}).strict();

const pythVaaConfigSchema = z.object({
  governance_target_chain: z.number().int().min(0).max(0xffff),
  router_verifier: z.object({
    router_set_index: z.number().int().min(0).max(U32_MAX),
    routers: z.array(z.object({ bytes: z.string() })).length(ROUTER_COUNT),
    expected_emitter_chain: z.number().int().min(0).max(0xffff),
    expected_emitter_address: z.string(),
  }),
}).passthrough();

export interface RouterSetUpdaterConfig {
  endpoint: string;
  authenticationToken?: string;
  unsafeAllowInsecureEndpoints?: boolean;
  fetch?: typeof fetch;
}

export interface RouterSetUpgradeVaa {
  vaa: string;
  currentRouterSetIndex: number;
  newRouterSetIndex: number;
  signatureCount: number;
}

interface RouterConfig {
  routerSetIndex: number;
  routerAddresses: string[];
  governanceTargetChain: number;
  expectedEmitterChain: number;
  expectedEmitterAddress: Uint8Array;
}

interface RouterSignature {
  routerIndex: number;
}

interface ParsedRouterSetUpdate {
  routerSetIndex: number;
}

export class RouterSetUpdater {
  readonly #endpoint: URL;
  readonly #authenticationToken?: string;
  readonly #fetch: typeof fetch;

  constructor(config: RouterSetUpdaterConfig) {
    const onlySecureEndpoints = !(config.unsafeAllowInsecureEndpoints ?? false);
    validateEndpointUrl(config.endpoint, "HERMES_ENDPOINT", onlySecureEndpoints);
    this.#endpoint = withTrailingSlash(new URL(config.endpoint));
    this.#authenticationToken = config.authenticationToken;
    this.#fetch = config.fetch ?? fetch;
  }

  async buildUpgradeVaa(config: PythVaaConfigResponse): Promise<RouterSetUpgradeVaa | undefined> {
    const routerConfig = parsePythVaaConfig(config);
    const vaa = await this.#fetchUpgradeVaa();
    if (!vaa) {
      return undefined;
    }

    return parseAggregateUpgradeVaa(vaa, routerConfig);
  }

  async #fetchUpgradeVaa(): Promise<Uint8Array | undefined> {
    const response = await this.#fetch(new URL("v1/guardian_set_upgrade_vaa", this.#endpoint), {
      headers: this.#authenticationToken
        ? { Authorization: `Bearer ${this.#authenticationToken}` }
        : undefined,
    });

    if (response.status === 404) {
      return undefined;
    }

    if (!response.ok) {
      throw new Error(`Pyth Hermes guardian set upgrade endpoint returned HTTP ${response.status}`);
    }

    const rawBody: unknown = await response.json();
    const parsed = guardianSetUpgradeVaaSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new Error(`Invalid Pyth guardian set upgrade response: ${z.prettifyError(parsed.error)}`);
    }

    return decodeHex(parsed.data.vaa, "vaa");
  }
}

function parsePythVaaConfig(config: PythVaaConfigResponse): RouterConfig {
  const parsed = pythVaaConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`Invalid pyth_vaa config: ${z.prettifyError(parsed.error)}`);
  }

  const routerAddresses = parsed.data.router_verifier.routers.map((router, index) => {
    const bytes = Buffer.from(router.bytes, "base64");
    if (bytes.length !== ROUTER_ADDRESS_LEN) {
      throw new Error(`Invalid router address length at index ${index}`);
    }

    return bytesToHex(bytes);
  });

  if (new Set(routerAddresses).size !== routerAddresses.length) {
    throw new Error("Invalid pyth_vaa config: duplicate router addresses");
  }

  const expectedEmitterAddress = Buffer.from(
    parsed.data.router_verifier.expected_emitter_address,
    "base64",
  );
  if (expectedEmitterAddress.length !== VAA_EMITTER_ADDRESS_LEN) {
    throw new Error("Invalid pyth_vaa config: invalid expected emitter address length");
  }

  return {
    routerSetIndex: parsed.data.router_verifier.router_set_index,
    routerAddresses,
    governanceTargetChain: parsed.data.governance_target_chain,
    expectedEmitterChain: parsed.data.router_verifier.expected_emitter_chain,
    expectedEmitterAddress,
  };
}

function parseAggregateUpgradeVaa(
  vaa: Uint8Array,
  routerConfig: RouterConfig,
): RouterSetUpgradeVaa {
  if (vaa.length < VAA_HEADER_LEN) {
    throw new Error("Invalid Pyth router set upgrade VAA length");
  }

  if (vaa[0] !== VAA_VERSION) {
    throw new Error("Invalid Pyth router set upgrade VAA version");
  }

  const currentRouterSetIndex = readU32(vaa, 1);
  if (currentRouterSetIndex !== routerConfig.routerSetIndex) {
    throw new Error(`No router set upgrade VAA found for current router set index ${routerConfig.routerSetIndex}`);
  }

  const signatureCount = vaa[5];
  if (signatureCount < ROUTER_QUORUM) {
    throw new Error(`Pyth router set upgrade only had ${signatureCount} signatures; ${ROUTER_QUORUM} required`);
  }
  if (signatureCount > ROUTER_COUNT) {
    throw new Error(`Invalid Pyth router set upgrade signature count: ${signatureCount}`);
  }

  const bodyStart = VAA_HEADER_LEN + signatureCount * VAA_SIGNATURE_LEN;
  if (vaa.length <= bodyStart) {
    throw new Error("Invalid Pyth router set upgrade VAA body length");
  }

  const body = vaa.subarray(bodyStart);
  validateEmitter(body, routerConfig);
  validateVaaSignatures({
    body,
    routerAddresses: routerConfig.routerAddresses,
    signatureCount,
    vaa,
  });

  const update = parseRouterSetUpdate(body, routerConfig.governanceTargetChain);
  const expectedNextIndex = routerConfig.routerSetIndex + 1;
  if (update.routerSetIndex !== expectedNextIndex) {
    throw new Error(`No router set upgrade VAA found for current router set index ${routerConfig.routerSetIndex}`);
  }

  return {
    vaa: Buffer.from(vaa).toString("base64"),
    currentRouterSetIndex,
    newRouterSetIndex: update.routerSetIndex,
    signatureCount,
  };
}

function parseRouterSetUpdate(body: Uint8Array, governanceTargetChain: number): ParsedRouterSetUpdate {
  const data = parseGovernanceRouterSetUpdate(body, governanceTargetChain);
  if (data.length < 5) {
    throw new Error("Invalid Pyth router set upgrade payload length");
  }

  const routerSetIndex = readU32(data, 0);
  const routerCount = data[4];
  if (routerCount !== ROUTER_COUNT) {
    throw new Error(`Invalid Pyth router count in upgrade body: ${routerCount}`);
  }

  const expectedBodyLength = 5 + ROUTER_COUNT * ROUTER_ADDRESS_LEN;
  if (data.length !== expectedBodyLength) {
    throw new Error("Invalid Pyth router set upgrade payload length");
  }

  const routers = new Set<string>();
  for (let i = 0; i < ROUTER_COUNT; i++) {
    const routerStart = 5 + i * ROUTER_ADDRESS_LEN;
    const router = data.subarray(routerStart, routerStart + ROUTER_ADDRESS_LEN);
    const routerHex = bytesToHex(router);
    if (routers.has(routerHex)) {
      throw new Error("Invalid Pyth router set upgrade: duplicate router addresses");
    }
    routers.add(routerHex);
  }

  return { routerSetIndex };
}

function parseGovernanceRouterSetUpdate(body: Uint8Array, governanceTargetChain: number): Uint8Array {
  if (body.length < VAA_BODY_PAYLOAD_POS + GOVERNANCE_PAYLOAD_POS) {
    throw new Error("Invalid Pyth router set upgrade body length");
  }

  const module = Buffer.from(
    body.subarray(
      VAA_BODY_PAYLOAD_POS,
      VAA_BODY_PAYLOAD_POS + GOVERNANCE_MODULE_LEN,
    ),
  ).toString("utf8").replaceAll("\0", "");
  if (module !== "Core") {
    throw new Error("Invalid Pyth router set upgrade governance module");
  }

  const action = body[VAA_BODY_PAYLOAD_POS + GOVERNANCE_ACTION_POS];
  if (action !== GOVERNANCE_ACTION_ROUTER_SET_UPGRADE) {
    throw new Error("Invalid Pyth router set upgrade governance action");
  }

  const targetChain = readU16(body, VAA_BODY_PAYLOAD_POS + GOVERNANCE_TARGET_CHAIN_POS);
  if (targetChain !== GOVERNANCE_TARGET_CHAIN_GLOBAL && targetChain !== governanceTargetChain) {
    throw new Error("Invalid Pyth router set upgrade governance target chain");
  }

  return body.subarray(VAA_BODY_PAYLOAD_POS + GOVERNANCE_PAYLOAD_POS);
}

function validateEmitter(body: Uint8Array, routerConfig: RouterConfig): void {
  if (body.length < VAA_BODY_PAYLOAD_POS) {
    throw new Error("Invalid Pyth router set upgrade VAA body length");
  }

  const emitterChain = readU16(body, VAA_EMITTER_CHAIN_POS);
  const emitterAddress = body.subarray(
    VAA_EMITTER_ADDRESS_POS,
    VAA_EMITTER_ADDRESS_POS + VAA_EMITTER_ADDRESS_LEN,
  );
  if (
    emitterChain !== routerConfig.expectedEmitterChain
    || !bytesEqual(emitterAddress, routerConfig.expectedEmitterAddress)
  ) {
    throw new Error("Invalid Pyth router set upgrade emitter");
  }
}

function validateVaaSignatures(input: {
  vaa: Uint8Array;
  signatureCount: number;
  body: Uint8Array;
  routerAddresses: string[];
}): void {
  let lastRouterIndex = -1;
  const seen = new Set<number>();

  for (let i = 0; i < input.signatureCount; i++) {
    const signatureStart = VAA_HEADER_LEN + i * VAA_SIGNATURE_LEN;
    const routerIndex = input.vaa[signatureStart];
    if (routerIndex <= lastRouterIndex) {
      throw new Error("Invalid Pyth router set upgrade signature order");
    }
    if (routerIndex >= input.routerAddresses.length) {
      throw new Error(`Invalid Pyth router set upgrade router index: ${routerIndex}`);
    }
    if (seen.has(routerIndex)) {
      throw new Error("Invalid Pyth router set upgrade duplicate signature index");
    }

    const recovered = recoverRouterSignature({
      body: input.body,
      signature: input.vaa.subarray(signatureStart + 1, signatureStart + VAA_SIGNATURE_LEN),
      routerAddresses: input.routerAddresses,
    });
    if (recovered.routerIndex !== routerIndex) {
      throw new Error("Pyth router set upgrade signature does not match claimed router index");
    }

    seen.add(routerIndex);
    lastRouterIndex = routerIndex;
  }
}

function recoverRouterSignature(input: {
  body: Uint8Array;
  signature: Uint8Array;
  routerAddresses: string[];
}): RouterSignature {
  if (input.signature.length !== SIGNATURE_LEN) {
    throw new Error(`Invalid Pyth router set upgrade signature length: ${input.signature.length}`);
  }

  const hash = keccak_256(keccak_256(input.body));
  const candidates = signatureCandidates(input.signature);

  for (const candidate of candidates) {
    try {
      const signature = secp256k1.Signature.fromBytes(candidate.recoveredSignature, "recovered");
      const recoveredKey = signature.recoverPublicKey(hash).toBytes(false);
      const recoveredRouter = bytesToHex(keccak_256(recoveredKey.subarray(1)).subarray(12));
      const routerIndex = input.routerAddresses.indexOf(recoveredRouter);
      if (routerIndex >= 0) {
        return { routerIndex };
      }
    } catch {
      continue;
    }
  }

  throw new Error("Pyth router set upgrade signature does not match any configured router");
}

function signatureCandidates(signature: Uint8Array): Array<{
  recoveredSignature: Uint8Array;
}> {
  const rsvRecoveryId = normalizeRecoveryId(signature[COMPACT_SIGNATURE_LEN]);
  const vrsRecoveryId = normalizeRecoveryId(signature[0]);
  const candidates: Array<{
    recoveredSignature: Uint8Array;
  }> = [];

  if (rsvRecoveryId !== undefined) {
    const compact = signature.subarray(0, COMPACT_SIGNATURE_LEN);
    candidates.push({
      recoveredSignature: concatBytes(Uint8Array.of(rsvRecoveryId), compact),
    });
  }

  if (vrsRecoveryId !== undefined) {
    const compact = signature.subarray(1);
    candidates.push({
      recoveredSignature: concatBytes(Uint8Array.of(vrsRecoveryId), compact),
    });
  }

  return candidates;
}

function decodeHex(value: string, fieldName: string): Uint8Array {
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(normalized)) {
    throw new Error(`Invalid Pyth router set upgrade ${fieldName}: expected hex bytes`);
  }

  return Buffer.from(normalized, "hex");
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
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

function readU16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0, false);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

function normalizeRecoveryId(value: number): number | undefined {
  if (value === 0 || value === 1) return value;
  if (value === 27 || value === 28) return value - 27;
  return undefined;
}

function withTrailingSlash(url: URL): URL {
  return new URL(url.href.endsWith("/") ? url.href : `${url.href}/`);
}
