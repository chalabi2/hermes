import { describe, it, expect } from "vitest";
import {
  validateEndpointUrl,
  validateAkashAddress,
  validateFeeAmount,
  sanitizeErrorMessage,
  validateMnemonicFormat,
  validateWalletSecret,
  validateContractAddress,
} from "./validation.ts";

// ============================================================
// SEC-02: Endpoint URL validation (SSRF prevention)
// ============================================================
describe("SEC-02: validateEndpointUrl", () => {
  it("accepts valid HTTPS URLs", () => {
    expect(validateEndpointUrl("https://rpc.akashnet.net:443", "rpc")).toBe("https://rpc.akashnet.net:443");
    expect(validateEndpointUrl("https://pyth.dourolabs.app/hermes", "hermes")).toBe("https://pyth.dourolabs.app/hermes");
  });

  it("rejects HTTP URLs (non-encrypted)", () => {
    expect(() => validateEndpointUrl("http://rpc.akashnet.net", "rpc"))
      .toThrow("only HTTPS endpoints are allowed");
  });

  it("rejects FTP and other schemes", () => {
    expect(() => validateEndpointUrl("ftp://example.com", "rpc"))
      .toThrow("only HTTPS endpoints are allowed");
  });

  it("rejects file:// scheme (local file access)", () => {
    expect(() => validateEndpointUrl("file:///etc/passwd", "rpc"))
      .toThrow("only HTTPS endpoints are allowed");
  });

  it("rejects javascript: scheme", () => {
    expect(() => validateEndpointUrl("javascript:alert(1)", "rpc"))
      .toThrow(/not a valid URL|only HTTPS endpoints are allowed/);
  });

  it("rejects localhost (SSRF)", () => {
    expect(() => validateEndpointUrl("https://localhost/api", "rpc"))
      .toThrow("private or internal addresses are not allowed");
  });

  it("rejects 127.x.x.x loopback (SSRF)", () => {
    expect(() => validateEndpointUrl("https://127.0.0.1/api", "rpc"))
      .toThrow("private or internal addresses are not allowed");
  });

  it("rejects 10.x.x.x private range (SSRF)", () => {
    expect(() => validateEndpointUrl("https://10.0.0.1/api", "rpc"))
      .toThrow("private or internal addresses are not allowed");
  });

  it("rejects 172.16-31.x.x private range (SSRF)", () => {
    expect(() => validateEndpointUrl("https://172.16.0.1/api", "rpc"))
      .toThrow("private or internal addresses are not allowed");
  });

  it("rejects 192.168.x.x private range (SSRF)", () => {
    expect(() => validateEndpointUrl("https://192.168.1.1/api", "rpc"))
      .toThrow("private or internal addresses are not allowed");
  });

  it("rejects IPv6 loopback (SSRF)", () => {
    expect(() => validateEndpointUrl("https://[::1]/api", "rpc"))
      .toThrow("private or internal addresses are not allowed");
  });

  it("rejects .local domains (SSRF)", () => {
    expect(() => validateEndpointUrl("https://myhost.local/api", "rpc"))
      .toThrow("private or internal addresses are not allowed");
  });

  it("rejects 169.254.x.x link-local (SSRF)", () => {
    expect(() => validateEndpointUrl("https://169.254.169.254/metadata", "rpc"))
      .toThrow("private or internal addresses are not allowed");
  });

  it("rejects invalid URL strings", () => {
    expect(() => validateEndpointUrl("not-a-url", "rpc"))
      .toThrow("not a valid URL");
  });

  it("rejects empty string", () => {
    expect(() => validateEndpointUrl("", "rpc"))
      .toThrow("not a valid URL");
  });
});

// ============================================================
// SEC-05: Admin transfer address validation
// ============================================================
describe("SEC-05: validateAkashAddress", () => {
  it("accepts valid Akash addresses", () => {
    // Valid bech32 format: akash1 + 38 lowercase alphanumeric chars
    expect(() => validateAkashAddress("akash1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu"))
      .not.toThrow();
  });

  it("rejects empty string", () => {
    expect(() => validateAkashAddress("")).toThrow("Invalid address format");
  });

  it("rejects addresses with wrong prefix", () => {
    expect(() => validateAkashAddress("cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5abc123"))
      .toThrow("Invalid address format");
  });

  it("rejects addresses that are too short", () => {
    expect(() => validateAkashAddress("akash1short")).toThrow("Invalid address format");
  });

  it("rejects addresses with uppercase characters", () => {
    expect(() => validateAkashAddress("akash1QYPQXPQ9QCRSSZG2PVXQ6RS0ZQG3YYC5LZV7XU"))
      .toThrow("Invalid address format");
  });

  it("rejects addresses with special characters (injection)", () => {
    expect(() => validateAkashAddress("akash1'; DROP TABLE accounts;--aaaaaaaaaaa"))
      .toThrow("Invalid address format");
  });
});

// ============================================================
// SEC-06: Fee amount validation
// ============================================================
describe("SEC-06: validateFeeAmount", () => {
  it("accepts valid integer fee strings", () => {
    expect(validateFeeAmount("100")).toBe("100");
    expect(validateFeeAmount("0")).toBe("0");
    expect(validateFeeAmount("1000000")).toBe("1000000");
  });

  it("rejects negative numbers", () => {
    expect(() => validateFeeAmount("-100")).toThrow("non-negative integer");
  });

  it("rejects decimal numbers", () => {
    expect(() => validateFeeAmount("100.5")).toThrow("non-negative integer");
  });

  it("rejects non-numeric strings", () => {
    expect(() => validateFeeAmount("abc")).toThrow("non-negative integer");
  });

  it("rejects empty string", () => {
    expect(() => validateFeeAmount("")).toThrow("non-negative integer");
  });

  it("rejects strings with spaces", () => {
    expect(() => validateFeeAmount("100 200")).toThrow("non-negative integer");
  });

  it("rejects scientific notation", () => {
    expect(() => validateFeeAmount("1e18")).toThrow("non-negative integer");
  });

  it("rejects excessively large values (>78 digits, Uint256 overflow)", () => {
    const hugeNumber = "9".repeat(79);
    expect(() => validateFeeAmount(hugeNumber)).toThrow("exceeds maximum");
  });
});

// ============================================================
// SEC-03: Wallet secret validation
// ============================================================
describe("SEC-03: validateWalletSecret", () => {
  it("accepts valid mnemonic secret", () => {
    expect(() => validateWalletSecret({
      type: "mnemonic",
      value: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    })).not.toThrow();
  });

  it("accepts valid 24-word mnemonic secret", () => {
    const words = Array(24).fill("abandon");
    words[23] = "about";
    expect(() => validateWalletSecret({
      type: "mnemonic",
      value: words.join(" "),
    })).not.toThrow();
  });

  it("rejects mnemonic with wrong word count", () => {
    expect(() => validateWalletSecret({
      type: "mnemonic",
      value: "abandon abandon abandon",
    })).toThrow("Invalid mnemonic");
  });

  it("accepts valid private key secret", () => {
    // Valid secp256k1 private key (32 bytes hex)
    const validKey = "a".repeat(64);
    expect(() => validateWalletSecret({
      type: "privateKey",
      value: validKey,
    })).not.toThrow();
  });

  it("rejects invalid private key", () => {
    expect(() => validateWalletSecret({
      type: "privateKey",
      value: "not-a-valid-hex-key",
    })).toThrow("Invalid private key");
  });

  it("rejects empty private key", () => {
    expect(() => validateWalletSecret({
      type: "privateKey",
      value: "",
    })).toThrow("Invalid private key");
  });
});

// ============================================================
// SEC-04: Error message sanitization
// ============================================================
describe("SEC-04: sanitizeErrorMessage", () => {
  it("includes context prefix", () => {
    const result = sanitizeErrorMessage(new Error("connection refused"), "Failed to update price");
    expect(result).toContain("Failed to update price");
  });

  it("strips file paths from errors", () => {
    const result = sanitizeErrorMessage(
      new Error("Error at /home/user/app/src/hermes-client.ts:42"),
      "Operation failed",
    );
    expect(result).not.toContain("/home/user");
    expect(result).not.toContain("hermes-client.ts");
  });

  it("strips stack trace information", () => {
    const err = new Error("Something failed");
    err.stack = "Error: Something failed\n    at HermesClient.initialize (/app/src/hermes-client.ts:42:5)";
    const result = sanitizeErrorMessage(err, "Init failed");
    expect(result).not.toContain("at HermesClient");
    expect(result).not.toContain("/app/src");
  });

  it("strips JSON response bodies", () => {
    const result = sanitizeErrorMessage(
      new Error('Request failed: {"error":"unauthorized","api_key":"sk_test_abc123"}'),
      "API error",
    );
    expect(result).not.toContain("api_key");
    expect(result).not.toContain("sk_test_abc123");
  });

  it("handles non-Error objects safely", () => {
    const result = sanitizeErrorMessage("some string error", "Context");
    expect(result).toBe("Context: an unexpected error occurred");
  });

  it("handles null/undefined errors", () => {
    const result = sanitizeErrorMessage(null, "Context");
    expect(result).toBe("Context: an unexpected error occurred");
    const result2 = sanitizeErrorMessage(undefined, "Context");
    expect(result2).toBe("Context: an unexpected error occurred");
  });
});

// ============================================================
// SEC-01: Mnemonic validation (never exposes content)
// ============================================================
describe("SEC-01: validateMnemonicFormat", () => {
  it("accepts valid 12-word mnemonic", () => {
    const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    expect(() => validateMnemonicFormat(mnemonic)).not.toThrow();
  });

  it("accepts valid 24-word mnemonic", () => {
    const words = Array(24).fill("abandon");
    words[23] = "about";
    expect(() => validateMnemonicFormat(words.join(" "))).not.toThrow();
  });

  it("rejects mnemonics with wrong word count", () => {
    expect(() => validateMnemonicFormat("abandon abandon abandon"))
      .toThrow("must be 12 or 24 words");
  });

  it("rejects empty mnemonic", () => {
    expect(() => validateMnemonicFormat(""))
      .toThrow("must be 12 or 24 words");
  });

  it("rejects mnemonics with non-alphabetic characters", () => {
    const mnemonic = "abandon 123abc abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    expect(() => validateMnemonicFormat(mnemonic))
      .toThrow("invalid characters");
  });

  it("rejects mnemonics with uppercase (BIP39 words are lowercase)", () => {
    const mnemonic = "Abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    expect(() => validateMnemonicFormat(mnemonic))
      .toThrow("invalid characters");
  });

  it("error messages never contain the actual mnemonic words", () => {
    const secretMnemonic = "secretword abandon abandon abandon abandon abandon";
    try {
      validateMnemonicFormat(secretMnemonic);
    } catch (error) {
      if (error instanceof Error) {
        expect(error.message).not.toContain("secretword");
      }
    }
  });
});

// ============================================================
// SEC-05b: Contract address validation
// ============================================================
describe("SEC-05b: validateContractAddress", () => {
  it("accepts valid contract addresses", () => {
    const addr = "akash1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu";
    expect(() => validateContractAddress(addr)).not.toThrow();
  });

  it("rejects non-akash prefixed addresses", () => {
    expect(() => validateContractAddress("cosmos1abc"))
      .toThrow("Invalid contract address format");
  });

  it("rejects empty string", () => {
    expect(() => validateContractAddress(""))
      .toThrow("Invalid contract address format");
  });
});
