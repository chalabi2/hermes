import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { z } from "zod";

import type { PythVaaConfigResponse } from "../contract-client/contract-client.service.ts";
import { validateEndpointUrl } from "../../validation.ts";

export const DEFAULT_PYTH_ROUTER_ENDPOINTS = [
  "https://pyth-lazer-0.dourolabs.app/v1",
  "https://pyth-lazer-1.dourolabs.app/v1",
  "https://pyth-lazer-2.dourolabs.app/v1",
];

const ROUTER_COUNT = 5;
const ROUTER_QUORUM = 3;
const ROUTER_ADDRESS_LEN = 20;
const VAA_VERSION = 1;
const VAA_HEADER_LEN = 6;
const VAA_SIGNATURE_LEN = 66;
const VAA_BODY_PAYLOAD_POS = 51;
const GOVERNANCE_MODULE_LEN = 32;
const GOVERNANCE_ACTION_POS = 32;
const GOVERNANCE_PAYLOAD_POS = 35;
const GOVERNANCE_ACTION_ROUTER_SET_UPGRADE = 2;
const SIGNATURE_LEN = 65;
const COMPACT_SIGNATURE_LEN = 64;
const U32_MAX = 0xffffffff;

const signedRouterSetUpgradeSchema = z.object({
  current_guardian_set_index: z.number().int().min(0).max(U32_MAX),
  new_guardian_set_index: z.number().int().min(0).max(U32_MAX),
  new_guardian_keys: z.array(
    z.array(z.number().int().min(0).max(255)).length(ROUTER_ADDRESS_LEN),
  ).length(ROUTER_COUNT),
  body: z.string(),
  signature: z.string(),
}).strict();

const pythVaaConfigSchema = z.object({
  router_verifier: z.object({
    router_set_index: z.number().int().min(0).max(U32_MAX),
    routers: z.array(z.object({ bytes: z.string() })).length(ROUTER_COUNT),
  }),
}).passthrough();

type SignedRouterSetUpgrade = z.infer<typeof signedRouterSetUpgradeSchema>;

export interface RouterSetUpdaterConfig {
  endpoints: string[];
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

interface RouterSetUpgradeShare {
  currentRouterSetIndex: number;
  newRouterSetIndex: number;
  body: Uint8Array;
  signature: Uint8Array;
}

interface RouterConfig {
  routerSetIndex: number;
  routerAddresses: string[];
}

interface RouterSignature {
  routerIndex: number;
  signature: Uint8Array;
}

type FetchResult =
  | { kind: "upgrade"; endpoint: string; share: RouterSetUpgradeShare }
  | { kind: "no_upgrade"; endpoint: string }
  | { kind: "failed"; endpoint: string; error: Error };

export class RouterSetUpdater {
  readonly #endpoints: URL[];
  readonly #authenticationToken?: string;
  readonly #fetch: typeof fetch;

  constructor(config: RouterSetUpdaterConfig) {
    if (config.endpoints.length < ROUTER_QUORUM) {
      throw new Error(`At least ${ROUTER_QUORUM} Pyth router endpoints are required`);
    }

    const onlySecureEndpoints = !(config.unsafeAllowInsecureEndpoints ?? false);
    this.#endpoints = config.endpoints.map((endpoint) => {
      validateEndpointUrl(endpoint, "PYTH_ROUTER_ENDPOINTS", onlySecureEndpoints);
      return withTrailingSlash(new URL(endpoint));
    });
    this.#authenticationToken = config.authenticationToken;
    this.#fetch = config.fetch ?? fetch;
  }

  async buildUpgradeVaa(config: PythVaaConfigResponse): Promise<RouterSetUpgradeVaa | undefined> {
    const routerConfig = parsePythVaaConfig(config);
    const results = await Promise.all(
      this.#endpoints.map(async (endpoint): Promise<FetchResult> => {
        try {
          return await this.#fetchUpgradeShare(endpoint);
        } catch (error) {
          return {
            kind: "failed",
            endpoint: endpoint.toString(),
            error: toError(error),
          };
        }
      }),
    );

    const shares = results
      .filter((result): result is Extract<FetchResult, { kind: "upgrade" }> => result.kind === "upgrade")
      .map(result => result.share);

    if (shares.length === 0) {
      const failed = results.filter((result): result is Extract<FetchResult, { kind: "failed" }> => result.kind === "failed");
      if (failed.length === results.length) {
        throw new Error(`All Pyth router set upgrade endpoints failed: ${failed.map(formatEndpointError).join("; ")}`);
      }

      return undefined;
    }

    const expectedNextIndex = routerConfig.routerSetIndex + 1;
    const eligibleShares = shares.filter(
      share =>
        share.currentRouterSetIndex === routerConfig.routerSetIndex &&
        share.newRouterSetIndex === expectedNextIndex,
    );

    if (eligibleShares.length === 0) {
      throw new Error(
        `No router set upgrade VAA found for current router set index ${routerConfig.routerSetIndex}`,
      );
    }

    const shareGroup = largestShareGroup(eligibleShares);
    const signatures = uniqueRouterSignatures(shareGroup.shares, routerConfig.routerAddresses);
    if (signatures.length < ROUTER_QUORUM) {
      throw new Error(
        `Pyth router set upgrade only had ${signatures.length} valid signatures; ${ROUTER_QUORUM} required`,
      );
    }

    return {
      vaa: assembleVaa({
        routerSetIndex: routerConfig.routerSetIndex,
        signatures: signatures.slice(0, ROUTER_QUORUM),
        body: shareGroup.body,
      }),
      currentRouterSetIndex: routerConfig.routerSetIndex,
      newRouterSetIndex: expectedNextIndex,
      signatureCount: ROUTER_QUORUM,
    };
  }

  async #fetchUpgradeShare(endpoint: URL): Promise<FetchResult> {
    const response = await this.#fetch(new URL("guardian_set_upgrade", endpoint), {
      headers: this.#authenticationToken
        ? { Authorization: `Bearer ${this.#authenticationToken}` }
        : undefined,
    });

    if (!response.ok) {
      throw new Error(`Pyth router endpoint returned HTTP ${response.status}`);
    }

    const rawBody: unknown = await response.json();
    if (rawBody === null) {
      return { kind: "no_upgrade", endpoint: endpoint.toString() };
    }

    return {
      kind: "upgrade",
      endpoint: endpoint.toString(),
      share: parseUpgradeShare(rawBody),
    };
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

  return {
    routerSetIndex: parsed.data.router_verifier.router_set_index,
    routerAddresses,
  };
}

function parseUpgradeShare(rawBody: unknown): RouterSetUpgradeShare {
  const parsed = signedRouterSetUpgradeSchema.safeParse(rawBody);
  if (!parsed.success) {
    throw new Error(`Invalid Pyth router set upgrade response: ${z.prettifyError(parsed.error)}`);
  }

  const body = decodeHex(parsed.data.body, "body");
  const signature = decodeHex(parsed.data.signature, "signature");
  if (signature.length !== SIGNATURE_LEN) {
    throw new Error(`Invalid Pyth router set upgrade signature length: ${signature.length}`);
  }

  validateBodyMatchesResponse(body, parsed.data);

  return {
    currentRouterSetIndex: parsed.data.current_guardian_set_index,
    newRouterSetIndex: parsed.data.new_guardian_set_index,
    body,
    signature,
  };
}

function validateBodyMatchesResponse(body: Uint8Array, response: SignedRouterSetUpgrade): void {
  const updateStart = VAA_BODY_PAYLOAD_POS + GOVERNANCE_PAYLOAD_POS;
  const expectedBodyLength = updateStart + 5 + ROUTER_COUNT * ROUTER_ADDRESS_LEN;
  if (body.length !== expectedBodyLength) {
    throw new Error("Invalid Pyth router set upgrade body length");
  }

  const module = Buffer.from(
    body.subarray(VAA_BODY_PAYLOAD_POS, VAA_BODY_PAYLOAD_POS + GOVERNANCE_MODULE_LEN),
  ).toString("utf8").replaceAll("\0", "");
  if (module !== "Core") {
    throw new Error("Invalid Pyth router set upgrade governance module");
  }

  const action = body[VAA_BODY_PAYLOAD_POS + GOVERNANCE_ACTION_POS];
  if (action !== GOVERNANCE_ACTION_ROUTER_SET_UPGRADE) {
    throw new Error("Invalid Pyth router set upgrade governance action");
  }

  const bodyRouterSetIndex = readU32(body, updateStart);
  if (bodyRouterSetIndex !== response.new_guardian_set_index) {
    throw new Error("Pyth router set upgrade body index does not match response index");
  }

  const routerCount = body[updateStart + 4];
  if (routerCount !== ROUTER_COUNT) {
    throw new Error(`Invalid Pyth router count in upgrade body: ${routerCount}`);
  }

  for (let i = 0; i < ROUTER_COUNT; i++) {
    const bodyStart = updateStart + 5 + i * ROUTER_ADDRESS_LEN;
    const bodyRouter = body.subarray(bodyStart, bodyStart + ROUTER_ADDRESS_LEN);
    const responseRouter = Uint8Array.from(response.new_guardian_keys[i]);
    if (!bytesEqual(bodyRouter, responseRouter)) {
      throw new Error(`Pyth router set upgrade body does not match response router ${i}`);
    }
  }
}

function largestShareGroup(shares: RouterSetUpgradeShare[]): {
  body: Uint8Array;
  shares: RouterSetUpgradeShare[];
} {
  const groups = new Map<string, RouterSetUpgradeShare[]>();
  for (const share of shares) {
    const bodyHex = bytesToHex(share.body);
    groups.set(bodyHex, [...(groups.get(bodyHex) ?? []), share]);
  }

  let selected: RouterSetUpgradeShare[] = [];
  for (const group of groups.values()) {
    if (group.length > selected.length) {
      selected = group;
    }
  }

  const [firstShare] = selected;
  if (!firstShare) {
    throw new Error("No router set upgrade shares found");
  }

  return {
    body: firstShare.body,
    shares: selected,
  };
}

function uniqueRouterSignatures(shares: RouterSetUpgradeShare[], routerAddresses: string[]): RouterSignature[] {
  const signatures = new Map<number, Uint8Array>();

  for (const share of shares) {
    const signature = recoverRouterSignature({
      body: share.body,
      signature: share.signature,
      routerAddresses,
    });

    if (!signatures.has(signature.routerIndex)) {
      signatures.set(signature.routerIndex, signature.signature);
    }
  }

  return Array.from(signatures.entries())
    .map(([routerIndex, signature]) => ({ routerIndex, signature }))
    .sort((a, b) => a.routerIndex - b.routerIndex);
}

function recoverRouterSignature(input: {
  body: Uint8Array;
  signature: Uint8Array;
  routerAddresses: string[];
}): RouterSignature {
  const hash = keccak_256(keccak_256(input.body));
  const candidates = signatureCandidates(input.signature);

  for (const candidate of candidates) {
    let recoveredKey: Uint8Array;
    try {
      recoveredKey = secp256k1.Signature
        .fromBytes(candidate.recoveredSignature, "recovered")
        .recoverPublicKey(hash)
        .toBytes(false);
    } catch {
      continue;
    }

    const recoveredRouter = bytesToHex(keccak_256(recoveredKey.subarray(1)).subarray(12));
    const routerIndex = input.routerAddresses.indexOf(recoveredRouter);
    if (routerIndex >= 0) {
      return {
        routerIndex,
        signature: candidate.contractSignature,
      };
    }
  }

  throw new Error("Pyth router set upgrade signature does not match any configured router");
}

function signatureCandidates(signature: Uint8Array): Array<{
  recoveredSignature: Uint8Array;
  contractSignature: Uint8Array;
}> {
  const rsvRecoveryId = normalizeRecoveryId(signature[COMPACT_SIGNATURE_LEN]);
  const vrsRecoveryId = normalizeRecoveryId(signature[0]);
  const candidates: Array<{
    recoveredSignature: Uint8Array;
    contractSignature: Uint8Array;
  }> = [];

  if (rsvRecoveryId !== undefined) {
    const compact = signature.subarray(0, COMPACT_SIGNATURE_LEN);
    candidates.push({
      recoveredSignature: concatBytes(Uint8Array.of(rsvRecoveryId), compact),
      contractSignature: concatBytes(compact, Uint8Array.of(rsvRecoveryId)),
    });
  }

  if (vrsRecoveryId !== undefined) {
    const compact = signature.subarray(1);
    candidates.push({
      recoveredSignature: concatBytes(Uint8Array.of(vrsRecoveryId), compact),
      contractSignature: concatBytes(compact, Uint8Array.of(vrsRecoveryId)),
    });
  }

  return candidates;
}

function assembleVaa(input: {
  routerSetIndex: number;
  signatures: RouterSignature[];
  body: Uint8Array;
}): string {
  const vaa = new Uint8Array(
    VAA_HEADER_LEN + input.signatures.length * VAA_SIGNATURE_LEN + input.body.length,
  );
  let offset = 0;
  vaa[offset++] = VAA_VERSION;
  writeU32(vaa, offset, input.routerSetIndex);
  offset += 4;
  vaa[offset++] = input.signatures.length;

  for (const signature of input.signatures) {
    vaa[offset++] = signature.routerIndex;
    vaa.set(signature.signature, offset);
    offset += SIGNATURE_LEN;
  }

  vaa.set(input.body, offset);

  return Buffer.from(vaa).toString("base64");
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

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset + offset, 4).setUint32(0, value, false);
}

function normalizeRecoveryId(value: number): number | undefined {
  if (value === 0 || value === 1) return value;
  if (value === 27 || value === 28) return value - 27;
  return undefined;
}

function withTrailingSlash(url: URL): URL {
  return new URL(url.href.endsWith("/") ? url.href : `${url.href}/`);
}

function formatEndpointError(result: Extract<FetchResult, { kind: "failed" }>): string {
  return `${result.endpoint} ${result.error.message}`;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error("unknown error");
}
