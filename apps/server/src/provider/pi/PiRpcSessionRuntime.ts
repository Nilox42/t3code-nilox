// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeChildProcess from "node:child_process";

import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 750;
const MAX_BUFFERED_STARTUP_EVENTS = 64;
const MAX_STDERR_CHARS = 64 * 1024;

export const PI_MINIMUM_VERSION = "0.82.0";
export const PI_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export const PiThinkingLevel = Schema.Literals(PI_THINKING_LEVELS);
export type PiThinkingLevel = typeof PiThinkingLevel.Type;

const OptionalString = Schema.optionalKey(Schema.String);
const OptionalBoolean = Schema.optionalKey(Schema.Boolean);
const OptionalNumber = Schema.optionalKey(Schema.Number);

export const PiModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  provider: Schema.String,
  api: OptionalString,
  reasoning: Schema.Boolean,
  input: Schema.Array(Schema.String),
  contextWindow: Schema.Number,
  maxTokens: Schema.Number,
  thinkingLevelMap: Schema.optionalKey(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
});
export type PiModel = typeof PiModel.Type;

export const PiRpcState = Schema.Struct({
  model: Schema.optionalKey(Schema.NullOr(PiModel)),
  thinkingLevel: PiThinkingLevel,
  isStreaming: Schema.Boolean,
  isCompacting: Schema.Boolean,
  steeringMode: Schema.String,
  followUpMode: Schema.String,
  sessionFile: OptionalString,
  sessionId: Schema.String,
  sessionName: OptionalString,
  autoCompactionEnabled: Schema.Boolean,
  messageCount: Schema.Number,
  pendingMessageCount: Schema.Number,
});
export type PiRpcState = typeof PiRpcState.Type;

export const PiRpcCommandInfo = Schema.Struct({
  name: Schema.String,
  description: OptionalString,
  source: Schema.String,
  location: OptionalString,
  path: OptionalString,
  sourceInfo: Schema.optionalKey(Schema.Unknown),
});
export type PiRpcCommandInfo = typeof PiRpcCommandInfo.Type;

export const PiRpcEntries = Schema.Struct({
  entries: Schema.Array(Schema.Unknown),
  leafId: Schema.NullOr(Schema.String),
});
export type PiRpcEntries = typeof PiRpcEntries.Type;

const PiRpcResponseEnvelope = Schema.Struct({
  id: OptionalString,
  type: Schema.Literal("response"),
  command: Schema.String,
  success: Schema.Boolean,
  data: Schema.optionalKey(Schema.Unknown),
  error: OptionalString,
});

const PI_RPC_EVENT_TYPES = [
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "bash_execution_update",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "queue_update",
  "entry_appended",
  "session_info_changed",
  "thinking_level_changed",
  "compaction_start",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "summarization_retry_scheduled",
  "summarization_retry_attempt_start",
  "summarization_retry_finished",
  "extension_error",
  "extension_ui_request",
] as const;
const PiRpcEventType = Schema.Literals(PI_RPC_EVENT_TYPES);
const knownPiRpcEventTypes = new Set<string>(PI_RPC_EVENT_TYPES);

const PiRpcEventEnvelope = Schema.Struct({
  type: PiRpcEventType,
  id: OptionalString,
  method: OptionalString,
  message: Schema.optionalKey(Schema.Unknown),
  assistantMessageEvent: Schema.optionalKey(Schema.Unknown),
  toolCallId: OptionalString,
  toolName: OptionalString,
  args: Schema.optionalKey(Schema.Unknown),
  partialResult: Schema.optionalKey(Schema.Unknown),
  result: Schema.optionalKey(Schema.Unknown),
  isError: OptionalBoolean,
  messages: Schema.optionalKey(Schema.Unknown),
  entry: Schema.optionalKey(Schema.Unknown),
  name: OptionalString,
  level: Schema.optionalKey(PiThinkingLevel),
  willRetry: OptionalBoolean,
  reason: OptionalString,
  error: OptionalString,
  errorMessage: OptionalString,
  finalError: OptionalString,
  attempt: OptionalNumber,
  maxAttempts: OptionalNumber,
  delayMs: OptionalNumber,
  success: OptionalBoolean,
  title: OptionalString,
  options: Schema.optionalKey(Schema.Array(Schema.String)),
  timeout: OptionalNumber,
  placeholder: OptionalString,
  prefill: OptionalString,
  notifyType: OptionalString,
  statusKey: OptionalString,
  statusText: OptionalString,
});
export type PiRpcEvent = typeof PiRpcEventEnvelope.Type;

const decodeResponseEnvelope = Schema.decodeUnknownSync(PiRpcResponseEnvelope);
const decodeEventEnvelope = Schema.decodeUnknownSync(PiRpcEventEnvelope);
const decodeState = Schema.decodeUnknownSync(PiRpcState);
const decodeModels = Schema.decodeUnknownSync(Schema.Struct({ models: Schema.Array(PiModel) }));
const decodeCommands = Schema.decodeUnknownSync(
  Schema.Struct({ commands: Schema.Array(PiRpcCommandInfo) }),
);
const decodeEntries = Schema.decodeUnknownSync(PiRpcEntries);
const decodeFork = Schema.decodeUnknownSync(
  Schema.Struct({ text: Schema.String, cancelled: Schema.Boolean }),
);
const decodeLastAssistantText = Schema.decodeUnknownSync(
  Schema.Struct({ text: Schema.NullOr(Schema.String) }),
);

export class PiRpcError extends Schema.TaggedErrorClass<PiRpcError>()("PiRpcError", {
  operation: Schema.String,
  detail: Schema.String,
  stderr: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Pi RPC ${this.operation} failed: ${this.detail}`;
  }
}
const isPiRpcError = Schema.is(PiRpcError);

export interface PiRpcResumeCursor {
  readonly schemaVersion: 1;
  readonly sessionFile: string;
  readonly sessionId: string;
}

export const PiRpcResumeCursorSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionFile: Schema.String,
  sessionId: Schema.String,
});

export interface PiRpcRuntimeOptions {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly agentDir?: string;
  readonly launchArgs?: string;
  readonly trustProjectResources?: boolean;
  readonly resumeCursor?: PiRpcResumeCursor;
  readonly extensionPath?: string;
  readonly mcpConfigPath?: string;
  readonly noSession?: boolean;
  readonly noTools?: boolean;
  readonly disableResources?: boolean;
  readonly requestTimeoutMs?: number;
  readonly shutdownGraceMs?: number;
}

interface PendingRequest {
  readonly command: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: PiRpcError) => void;
  readonly timer: NodeJS.Timeout;
}

interface RequestOptions {
  readonly terminalOnTimeout?: boolean;
  readonly timeoutMs?: number;
}

export interface PiRpcSessionRuntime {
  readonly getState: () => Effect.Effect<PiRpcState, PiRpcError>;
  readonly getAvailableModels: () => Effect.Effect<ReadonlyArray<PiModel>, PiRpcError>;
  readonly getCommands: () => Effect.Effect<ReadonlyArray<PiRpcCommandInfo>, PiRpcError>;
  readonly setModel: (provider: string, modelId: string) => Effect.Effect<PiModel, PiRpcError>;
  readonly setThinkingLevel: (level: PiThinkingLevel) => Effect.Effect<void, PiRpcError>;
  readonly prompt: (input: {
    readonly message: string;
    readonly images?: ReadonlyArray<{
      readonly type: "image";
      readonly data: string;
      readonly mimeType: string;
    }>;
    readonly streamingBehavior?: "steer" | "followUp";
  }) => Effect.Effect<void, PiRpcError>;
  readonly abort: () => Effect.Effect<void, PiRpcError>;
  readonly getEntries: (since?: string) => Effect.Effect<PiRpcEntries, PiRpcError>;
  readonly fork: (
    entryId: string,
  ) => Effect.Effect<{ readonly text: string; readonly cancelled: boolean }, PiRpcError>;
  readonly getLastAssistantText: () => Effect.Effect<string | null, PiRpcError>;
  readonly respondToExtensionUi: (response: {
    readonly id: string;
    readonly value?: string;
    readonly confirmed?: boolean;
    readonly cancelled?: boolean;
  }) => Effect.Effect<void, PiRpcError>;
  readonly onEvent: (listener: (event: PiRpcEvent, raw: unknown) => void) => () => void;
  readonly onExit: (
    listener: (exit: {
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }) => void,
  ) => () => void;
  readonly waitForSettled: (timeoutMs?: number) => Effect.Effect<void, PiRpcError>;
  readonly getStderr: () => string;
  readonly close: Effect.Effect<void>;
}

const RESERVED_LONG_FLAGS = new Set([
  "mode",
  "print",
  "provider",
  "model",
  "thinking",
  "api-key",
  "approve",
  "no-approve",
  "session",
  "session-id",
  "resume",
  "continue",
  "fork",
  "session-dir",
  "no-session",
  "mcp-config",
]);
const RESERVED_SHORT_FLAGS = new Set(["-p", "-a", "-na", "-r", "-c"]);

export function validatePiLaunchArgs(launchArgs: string | undefined): ReadonlyArray<string> {
  const tokens = [...tokenizeCliArgs(launchArgs)];
  for (const token of tokens) {
    if (RESERVED_SHORT_FLAGS.has(token)) {
      throw new PiRpcError({
        operation: "launch",
        detail: `Launch argument '${token}' is managed by T3 Code and cannot be overridden.`,
      });
    }
    if (token.startsWith("--")) {
      const flag = token.slice(2).split("=", 1)[0] ?? "";
      if (RESERVED_LONG_FLAGS.has(flag)) {
        throw new PiRpcError({
          operation: "launch",
          detail: `Launch argument '--${flag}' is managed by T3 Code and cannot be overridden.`,
        });
      }
      continue;
    }
    if (!token.startsWith("-")) {
      throw new PiRpcError({
        operation: "launch",
        detail: `Positional launch argument '${token}' is not allowed because T3 Code owns prompting.`,
      });
    }
  }
  return tokens;
}

export function parsePiVersion(output: string): string | null {
  return output.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null;
}

export function comparePiVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}

export function isSupportedPiVersion(version: string): boolean {
  return comparePiVersions(version, PI_MINIMUM_VERSION) >= 0;
}

export function parsePiModelSlug(
  slug: string | null | undefined,
): { readonly provider: string; readonly modelId: string } | null {
  const trimmed = slug?.trim();
  if (!trimmed) return null;
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) return null;
  return {
    provider: trimmed.slice(0, separator),
    modelId: trimmed.slice(separator + 1),
  };
}

export function supportedThinkingLevels(model: PiModel): ReadonlyArray<PiThinkingLevel> {
  if (!model.reasoning) return ["off"];
  const map = model.thinkingLevelMap ?? {};
  return PI_THINKING_LEVELS.filter((level) => {
    if (level === "xhigh" || level === "max") {
      return typeof map[level] === "string";
    }
    return map[level] !== null;
  });
}

export function clampPiThinkingLevel(
  requested: string | undefined,
  model: PiModel,
  fallback: PiThinkingLevel = "medium",
): PiThinkingLevel {
  const supported = supportedThinkingLevels(model);
  if (requested && supported.includes(requested as PiThinkingLevel)) {
    return requested as PiThinkingLevel;
  }
  if (supported.includes(fallback)) return fallback;
  return supported[0] ?? "off";
}

export function buildPiManagedArgs(options: PiRpcRuntimeOptions): ReadonlyArray<string> {
  const userArgs = validatePiLaunchArgs(options.launchArgs);
  return [
    ...userArgs,
    "--mode",
    "rpc",
    options.trustProjectResources ? "--approve" : "--no-approve",
    ...(options.noSession ? ["--no-session"] : []),
    ...(options.noTools ? ["--no-tools"] : []),
    ...(options.disableResources
      ? [
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-context-files",
          "--no-themes",
        ]
      : []),
    ...(options.extensionPath ? ["--extension", options.extensionPath] : []),
    ...(options.mcpConfigPath ? ["--mcp-config", options.mcpConfigPath] : []),
    ...(options.resumeCursor ? ["--session", options.resumeCursor.sessionFile] : []),
  ];
}

function asPiRpcError(
  operation: string,
  detail: string,
  cause?: unknown,
  stderr?: string,
): PiRpcError {
  return new PiRpcError({
    operation,
    detail,
    ...(stderr ? { stderr } : {}),
    ...(cause !== undefined ? { cause } : {}),
  });
}

function validateData<A>(command: string, data: unknown, decode: (input: unknown) => A): A {
  try {
    return decode(data);
  } catch (cause) {
    throw asPiRpcError(command, "Pi returned an invalid response payload.", cause);
  }
}

export const makePiRpcSessionRuntime = Effect.fn("makePiRpcSessionRuntime")(function* (
  options: PiRpcRuntimeOptions,
): Effect.fn.Return<PiRpcSessionRuntime, PiRpcError, Scope.Scope> {
  const scope = yield* Scope.Scope;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const args = yield* Effect.try({
    try: () => buildPiManagedArgs(options),
    catch: (cause) =>
      isPiRpcError(cause)
        ? cause
        : asPiRpcError("launch", "Failed to validate Pi launch arguments.", cause),
  });
  const spawnCommand = yield* resolveSpawnCommand(
    options.binaryPath || "pi",
    args,
    options.environment ? { env: options.environment } : {},
  );

  const child = yield* Effect.try({
    try: () =>
      NodeChildProcess.spawn(spawnCommand.command, [...spawnCommand.args], {
        cwd: options.cwd,
        env: {
          ...process.env,
          ...options.environment,
          ...(options.agentDir ? { PI_CODING_AGENT_DIR: options.agentDir } : {}),
        },
        shell: spawnCommand.shell,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }),
    catch: (cause) => asPiRpcError("launch", "Failed to spawn the Pi CLI.", cause),
  });

  let stderr = "";
  let stdoutBuffer = "";
  let closed = false;
  let requestSequence = 0;
  let terminalError: PiRpcError | undefined;
  const listeners = new Set<(event: PiRpcEvent, raw: unknown) => void>();
  const bufferedStartupEvents: Array<{ readonly event: PiRpcEvent; readonly raw: unknown }> = [];
  let eventListenerAttached = false;
  const exitListeners = new Set<
    (exit: { readonly code: number | null; readonly signal: NodeJS.Signals | null }) => void
  >();
  const settledWaiters = new Set<{
    readonly resolve: () => void;
    readonly reject: (error: PiRpcError) => void;
    readonly timer: NodeJS.Timeout;
  }>();
  const pending = new Map<string, PendingRequest>();
  const ignoredResponseIds = new Set<string>();

  const boundedStderr = () => stderr.slice(-MAX_STDERR_CHARS);
  const ignoreLateResponse = (id: string) => {
    ignoredResponseIds.add(id);
    const oldest = ignoredResponseIds.values().next().value;
    if (ignoredResponseIds.size > 32 && oldest !== undefined) {
      ignoredResponseIds.delete(oldest);
    }
  };
  const rejectOutstanding = (error: PiRpcError) => {
    terminalError = error;
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      pending.delete(id);
      request.reject(error);
    }
    for (const waiter of settledWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    settledWaiters.clear();
  };

  const protocolFailure = (detail: string, cause?: unknown) => {
    const error = asPiRpcError("protocol", detail, cause, boundedStderr());
    rejectOutstanding(error);
    if (!child.killed) child.kill();
  };

  const handleLine = (record: string) => {
    if (record.endsWith("\r")) record = record.slice(0, -1);
    if (record.length === 0) return;
    let raw: unknown;
    try {
      raw = JSON.parse(record);
    } catch (cause) {
      protocolFailure("Pi emitted malformed JSONL data.", cause);
      return;
    }
    if (
      typeof raw === "object" &&
      raw !== null &&
      "type" in raw &&
      (raw as { type?: unknown }).type === "response"
    ) {
      let response: typeof PiRpcResponseEnvelope.Type;
      try {
        response = decodeResponseEnvelope(raw);
      } catch (cause) {
        protocolFailure("Pi emitted an invalid response envelope.", cause);
        return;
      }
      if (!response.id) {
        protocolFailure("Pi emitted an uncorrelated command response.");
        return;
      }
      const request = pending.get(response.id);
      if (!request) {
        if (ignoredResponseIds.delete(response.id)) return;
        protocolFailure(`Pi emitted a response for unknown request '${response.id}'.`);
        return;
      }
      pending.delete(response.id);
      clearTimeout(request.timer);
      if (response.command !== request.command) {
        request.reject(
          asPiRpcError(
            request.command,
            `Pi correlated request '${response.id}' with unexpected command '${response.command}'.`,
          ),
        );
        return;
      }
      if (!response.success) {
        request.reject(
          asPiRpcError(
            request.command,
            response.error?.trim() || "Pi rejected the command.",
            undefined,
            boundedStderr(),
          ),
        );
        return;
      }
      request.resolve(response.data);
      return;
    }

    const eventType =
      typeof raw === "object" &&
      raw !== null &&
      "type" in raw &&
      typeof (raw as { readonly type?: unknown }).type === "string"
        ? (raw as { readonly type: string }).type
        : undefined;
    if (eventType !== undefined && !knownPiRpcEventTypes.has(eventType)) {
      runFork(Effect.logDebug("Ignoring unknown Pi RPC event", { eventType }));
      return;
    }

    let event: PiRpcEvent;
    try {
      event = decodeEventEnvelope(raw);
    } catch (cause) {
      protocolFailure("Pi emitted an invalid known event.", cause);
      return;
    }
    if (!eventListenerAttached) {
      bufferedStartupEvents.push({ event, raw });
      if (bufferedStartupEvents.length > MAX_BUFFERED_STARTUP_EVENTS) {
        bufferedStartupEvents.shift();
      }
    } else {
      for (const listener of listeners) listener(event, raw);
    }
    if (event.type === "agent_settled") {
      for (const waiter of settledWaiters) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
      settledWaiters.clear();
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString("utf8");
    for (;;) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const record = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      handleLine(record);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-MAX_STDERR_CHARS);
  });
  child.stdin.on("error", (cause) => {
    rejectOutstanding(asPiRpcError("process", "Pi stdin failed.", cause, boundedStderr()));
  });
  child.on("error", (cause) => {
    rejectOutstanding(asPiRpcError("process", "Pi process failed.", cause, boundedStderr()));
  });
  child.on("exit", (code, signal) => {
    closed = true;
    for (const listener of exitListeners) listener({ code, signal });
    if (stdoutBuffer.length > 0) {
      protocolFailure("Pi exited with an unterminated JSONL record.");
      stdoutBuffer = "";
    }
    if (pending.size > 0 || settledWaiters.size > 0) {
      rejectOutstanding(
        asPiRpcError(
          "process",
          `Pi exited unexpectedly (code ${code ?? "null"}, signal ${signal ?? "none"}).`,
          undefined,
          boundedStderr(),
        ),
      );
    }
  });

  const request = (
    command: string,
    body: Record<string, unknown>,
    requestOptions: RequestOptions = {},
  ): Promise<unknown> => {
    if (terminalError) return Promise.reject(terminalError);
    if (closed || !child.stdin.writable) {
      return Promise.reject(
        asPiRpcError(command, "Pi process is no longer writable.", undefined, boundedStderr()),
      );
    }
    const id = `t3-pi-${++requestSequence}`;
    const timeoutMs =
      requestOptions.timeoutMs ?? options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        const error = asPiRpcError(
          command,
          `Command timed out after ${timeoutMs}ms.`,
          undefined,
          boundedStderr(),
        );
        reject(error);
        if (requestOptions.terminalOnTimeout === false) {
          ignoreLateResponse(id);
          return;
        }
        rejectOutstanding(error);
        if (!child.killed) child.kill();
      }, timeoutMs);
      pending.set(id, { command, resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, type: command, ...body })}\n`, (cause) => {
        if (!cause) return;
        clearTimeout(timer);
        pending.delete(id);
        reject(asPiRpcError(command, "Failed writing to Pi stdin.", cause, boundedStderr()));
      });
    });
  };

  const commandEffect = <A>(
    command: string,
    body: Record<string, unknown>,
    decode: (data: unknown) => A,
  ): Effect.Effect<A, PiRpcError> =>
    Effect.tryPromise({
      try: async () => validateData(command, await request(command, body), decode),
      catch: (cause) =>
        isPiRpcError(cause)
          ? cause
          : asPiRpcError(command, "Pi command failed.", cause, boundedStderr()),
    });
  const voidCommand = (command: string, body: Record<string, unknown> = {}) =>
    commandEffect(command, body, () => undefined);

  const waitForSettled = (timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS) =>
    Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve, reject) => {
          if (terminalError) {
            reject(terminalError);
            return;
          }
          const waiter = {
            resolve,
            reject,
            timer: setTimeout(() => {
              settledWaiters.delete(waiter);
              reject(asPiRpcError("waitForSettled", `Timed out after ${timeoutMs}ms.`));
            }, timeoutMs),
          };
          settledWaiters.add(waiter);
        }),
      catch: (cause) =>
        isPiRpcError(cause)
          ? cause
          : asPiRpcError("waitForSettled", "Failed waiting for Pi to settle.", cause),
    });

  const abort = () =>
    Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve, reject) => {
          if (terminalError) {
            reject(terminalError);
            return;
          }
          const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
          let finished = false;
          const finish = (complete: () => void) => {
            if (finished) return;
            finished = true;
            clearTimeout(waiter.timer);
            settledWaiters.delete(waiter);
            complete();
          };
          const waiter = {
            resolve: () => finish(resolve),
            reject: (error: PiRpcError) => finish(() => reject(error)),
            timer: setTimeout(() => {
              const error = asPiRpcError("abort", `Timed out after ${timeoutMs}ms.`);
              finish(() => {
                rejectOutstanding(error);
                if (!child.killed) child.kill();
                reject(error);
              });
            }, timeoutMs),
          };
          settledWaiters.add(waiter);
          void request(
            "abort",
            {},
            { terminalOnTimeout: false, timeoutMs: timeoutMs + 1_000 },
          ).then(
            () => finish(resolve),
            (error: PiRpcError) => finish(() => reject(error)),
          );
        }),
      catch: (cause) =>
        isPiRpcError(cause)
          ? cause
          : asPiRpcError("abort", "Failed aborting the active Pi turn.", cause, boundedStderr()),
    });

  const close = Effect.promise(async () => {
    if (closed) return;
    for (const request of pending.values()) clearTimeout(request.timer);
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (!closed && !child.killed) child.kill("SIGTERM");
        resolve();
      }, options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (!closed && !child.killed) child.kill();
  });
  yield* Scope.addFinalizer(scope, close);

  return {
    getState: () => commandEffect("get_state", {}, decodeState),
    getAvailableModels: () =>
      commandEffect("get_available_models", {}, (data) => decodeModels(data).models),
    getCommands: () => commandEffect("get_commands", {}, (data) => decodeCommands(data).commands),
    setModel: (provider, modelId) =>
      commandEffect("set_model", { provider, modelId }, (data) =>
        validateData("set_model", data, Schema.decodeUnknownSync(PiModel)),
      ),
    setThinkingLevel: (level) => voidCommand("set_thinking_level", { level }),
    prompt: ({ message, images, streamingBehavior }) =>
      voidCommand("prompt", {
        message,
        ...(images && images.length > 0 ? { images } : {}),
        ...(streamingBehavior ? { streamingBehavior } : {}),
      }),
    abort,
    getEntries: (since) => commandEffect("get_entries", since ? { since } : {}, decodeEntries),
    fork: (entryId) => commandEffect("fork", { entryId }, decodeFork),
    getLastAssistantText: () =>
      commandEffect("get_last_assistant_text", {}, (data) => decodeLastAssistantText(data).text),
    respondToExtensionUi: (response) =>
      Effect.callback<void, PiRpcError>((resume) => {
        if (terminalError) {
          resume(Effect.fail(terminalError));
          return;
        }
        if (closed || !child.stdin.writable) {
          resume(
            Effect.fail(asPiRpcError("extension_ui_response", "Pi process is no longer writable.")),
          );
          return;
        }
        try {
          child.stdin.write(
            `${JSON.stringify({ type: "extension_ui_response", ...response })}\n`,
            (cause) => {
              resume(
                cause
                  ? Effect.fail(
                      asPiRpcError(
                        "extension_ui_response",
                        "Failed writing extension response.",
                        cause,
                      ),
                    )
                  : Effect.void,
              );
            },
          );
        } catch (cause) {
          resume(
            Effect.fail(
              asPiRpcError("extension_ui_response", "Failed writing extension response.", cause),
            ),
          );
        }
      }),
    onEvent: (listener) => {
      listeners.add(listener);
      if (!eventListenerAttached) {
        eventListenerAttached = true;
        for (const buffered of bufferedStartupEvents) {
          listener(buffered.event, buffered.raw);
        }
        bufferedStartupEvents.length = 0;
      }
      return () => listeners.delete(listener);
    },
    onExit: (listener) => {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    waitForSettled,
    getStderr: boundedStderr,
    close,
  };
});
