import EventEmitter from "node:events";
import { describe, it, expect, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { createCommandBuilder, type CreateCommandBuilderOptions } from "./create-command-builder.ts";

describe("createCommandBuilder", () => {
  it("calls parseConfig with process.env and passes config to command fn", async () => {
    const { command, mockProcess, handler } = setup();
    const wrappedCommand = command(handler);

    await wrappedCommand(fakeCommand("test"));

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        contractAddress: mockProcess.env.HC_CONTRACT_ADDRESS,
        walletSecret: {
          type: "mnemonic",
          value: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("exits with code 1 and logs error when config is invalid", async () => {
    const { command, mockProcess, logger } = setup({
      HC_CONTRACT_ADDRESS: "",
      HC_WALLET_SECRET: "",
    });
    const handler = vi.fn();
    const wrappedCommand = command(handler);

    await wrappedCommand(fakeCommand("test"));

    expect(handler).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Configuration error:"));
    expect(mockProcess.exit).toHaveBeenCalledWith(1);
  });

  it("ignores env vars without the HC_ prefix", async () => {
    const { command, mockProcess, logger } = setup({
      CONTRACT_ADDRESS: "akash1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu",
      WALLET_SECRET: "mnemonic:abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    });
    const handler = vi.fn();
    const wrappedCommand = command(handler);

    await wrappedCommand(fakeCommand("test"));

    expect(handler).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Configuration error:"));
    expect(mockProcess.exit).toHaveBeenCalledWith(1);
  });

  it("exits with code 0 on successful command execution", async () => {
    const { command, mockProcess } = setup();
    const wrappedCommand = command(vi.fn());

    await wrappedCommand(fakeCommand("test"));

    expect(mockProcess.exit).toHaveBeenCalledWith(0);
  });

  it("exits with code 1 and logs Error message on command failure", async () => {
    const { command, mockProcess, logger } = setup();
    const handler = vi.fn().mockRejectedValueOnce(new Error("something broke"));
    const wrappedCommand = command(handler);

    await wrappedCommand(fakeCommand("deploy"));

    expect(logger.error).toHaveBeenCalledWith('\nCommand "deploy" failed: something broke');
    expect(mockProcess.exit).toHaveBeenCalledWith(1);
  });

  it("exits with code 1 and logs generic message on non-Error throw", async () => {
    const { command, mockProcess, logger } = setup();
    const handler = vi.fn().mockRejectedValueOnce("string error");
    const wrappedCommand = command(handler);

    await wrappedCommand(fakeCommand("deploy"));

    expect(logger.error).toHaveBeenCalledWith('\nCommand "deploy" failed: an unexpected error occurred');
    expect(mockProcess.exit).toHaveBeenCalledWith(1);
  });

  it("passes extra arguments to the command handler", async () => {
    const { command } = setup();
    const handler = vi.fn();
    const wrappedCommand = command(handler);

    await wrappedCommand("arg1", 42, fakeCommand("test"));

    expect(handler).toHaveBeenCalledWith(expect.any(Object), "arg1", 42);
  });

  it("aborts signal on SIGINT", async () => {
    const { command, mockProcess } = setup();
    let capturedSignal: AbortSignal | undefined;
    const handler = vi.fn(async (config) => {
      capturedSignal = config.signal;
      mockProcess.emit("SIGINT");
    });
    const wrappedCommand = command(handler);

    await wrappedCommand(fakeCommand("test"));

    expect(capturedSignal!.aborted).toBe(true);
  });

  it("aborts signal on SIGTERM", async () => {
    const { command, mockProcess } = setup();
    let capturedSignal: AbortSignal | undefined;
    const handler = vi.fn(async (config) => {
      capturedSignal = config.signal;
      mockProcess.emit("SIGTERM");
    });
    const wrappedCommand = command(handler);

    await wrappedCommand(fakeCommand("test"));

    expect(capturedSignal!.aborted).toBe(true);
  });

  it("aborts signal in finally block after successful execution", async () => {
    const { command } = setup();
    let capturedSignal: AbortSignal | undefined;
    const handler = vi.fn(async (config) => {
      capturedSignal = config.signal;
    });
    const wrappedCommand = command(handler);

    await wrappedCommand(fakeCommand("test"));

    expect(capturedSignal!.aborted).toBe(true);
  });
});

function fakeCommand(name: string) {
  return { name: () => name };
}

function setup(env?: Record<string, string>) {
  const logger = mock<Console>();
  const mockProcess = Object.assign(new EventEmitter(), {
    env: env ?? {
      HC_CONTRACT_ADDRESS: "akash1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu",
      HC_HERMES_API_KEY: "secret-token",
      HC_WALLET_SECRET: "mnemonic:abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    },
    exit: vi.fn(),
  }) as unknown as CreateCommandBuilderOptions["process"] & EventEmitter;

  const command = createCommandBuilder({
    process: mockProcess,
    console: logger,
  });
  const handler = vi.fn();

  return { command, mockProcess, logger, handler };
}
