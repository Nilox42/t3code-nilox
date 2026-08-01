// @effect-diagnostics globalTimers:off
import {
  ApprovalRequestId,
  EventId,
  McpStatusSnapshot,
  type ModelSelection,
  type PiSettings,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
  type RuntimeMode,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import {
  PI_MCP_BEARER_TOKEN_ENV,
  PI_MCP_BRIDGE_ENABLED_ENV,
  PI_MCP_ENDPOINT_ENV,
  type PiMcpBridgeCapability,
} from "../pi/PiMcpBridge.ts";
import {
  PI_MCP_STATUS_BRIDGE_MARKER,
  PI_PERMISSION_BRIDGE_MARKER,
} from "../pi/PiPermissionBridge.ts";
import {
  clampPiThinkingLevel,
  makePiRpcSessionRuntime,
  parsePiModelSlug,
  PiRpcResumeCursorSchema,
  type PiRpcEvent,
  type PiModel,
  type PiRpcError,
  type PiRpcResumeCursor,
  type PiRpcSessionRuntime,
  type PiThinkingLevel,
} from "../pi/PiRpcSessionRuntime.ts";
import type { PiAdapterShape } from "../Services/PiAdapter.ts";

const PROVIDER = ProviderDriverKind.make("piAgent");
const isResumeCursor = Schema.is(PiRpcResumeCursorSchema);
const decodeMcpStatusSnapshot = Schema.decodeUnknownSync(McpStatusSnapshot);
const isAdapterProcessError = Schema.is(ProviderAdapterProcessError);
const isAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isAdapterSessionClosedError = Schema.is(ProviderAdapterSessionClosedError);
const isAdapterSessionNotFoundError = Schema.is(ProviderAdapterSessionNotFoundError);
const isAdapterValidationError = Schema.is(ProviderAdapterValidationError);

interface PiTurnRecord {
  readonly id: TurnId;
  items: Array<unknown>;
  userEntryId?: string;
  hasSessionEntries?: boolean;
}

type PendingUi =
  | {
      readonly kind: "approval";
      readonly piRequestId: string;
      readonly requestId: ApprovalRequestId;
      readonly requestType:
        | "command_execution_approval"
        | "file_read_approval"
        | "file_change_approval"
        | "dynamic_tool_call";
      timeoutHandle: NodeJS.Timeout | undefined;
    }
  | {
      readonly kind: "user-input";
      readonly piRequestId: string;
      readonly requestId: ApprovalRequestId;
      readonly method: "select" | "confirm" | "input" | "editor";
      readonly questionId: string;
      timeoutHandle: NodeJS.Timeout | undefined;
    };

interface AssistantBlock {
  readonly itemId: RuntimeItemId;
  readonly itemType: "assistant_message" | "reasoning";
  completed: boolean;
}

interface PiAssistantTokenUsage {
  readonly usedTokens: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
}

interface PiSessionContext {
  session: ProviderSession;
  readonly threadId: ThreadId;
  readonly scope: Scope.Closeable;
  readonly runtime: PiRpcSessionRuntime;
  readonly eventQueue: Queue.Queue<PiSessionSignal>;
  eventFiber: Fiber.Fiber<void, never> | undefined;
  unsubscribeEvent: (() => void) | undefined;
  unsubscribeExit: (() => void) | undefined;
  readonly pendingUi: Map<ApprovalRequestId, PendingUi>;
  readonly assistantBlocks: Map<string, AssistantBlock>;
  readonly assistantUsageByMessage: Map<number, PiAssistantTokenUsage>;
  assistantMessageSequence: number;
  activeAssistantMessageSequence: number | undefined;
  turns: Array<PiTurnRecord>;
  activeTurnId: TurnId | undefined;
  interruptingTurnId: TurnId | undefined;
  finalStopReason: string | undefined;
  readonly mcpServerNames: Set<string>;
  finalErrorMessage: string | undefined;
  toolUses: number;
  currentModel: PiModel | undefined;
  currentThinkingLevel: PiThinkingLevel;
  stopped: boolean;
  settledTurns: Set<TurnId>;
}

type PiSessionSignal =
  | { readonly type: "event"; readonly event: PiRpcEvent; readonly raw: unknown }
  | {
      readonly type: "exit";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }
  | {
      readonly type: "settle-if-active";
      readonly turnId: TurnId;
      readonly completion: Deferred.Deferred<void>;
    };

export interface PiAdapterOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly extensionPath: string;
  readonly mcpBridge: PiMcpBridgeCapability;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function piModelSlug(model: PiModel | undefined): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}

type PiTurnRehydration =
  | { readonly _tag: "Success"; readonly turns: Array<PiTurnRecord> }
  | { readonly _tag: "Unsupported"; readonly issue: string };

function rehydratePiTurnRecords(history: {
  readonly entries: ReadonlyArray<unknown>;
  readonly leafId: string | null;
}): PiTurnRehydration {
  if (history.leafId === null) return { _tag: "Success", turns: [] };

  const entriesById = new Map<string, Record<string, unknown>>();
  const duplicateIds = new Set<string>();
  for (const entry of history.entries) {
    if (!isRecord(entry)) continue;
    const id = nonEmpty(entry.id);
    if (!id) continue;
    if (entriesById.has(id)) duplicateIds.add(id);
    entriesById.set(id, entry);
  }

  const branch: Array<Record<string, unknown>> = [];
  const visited = new Set<string>();
  let entryId: string | null = history.leafId;
  while (entryId !== null) {
    if (visited.has(entryId)) {
      return {
        _tag: "Unsupported",
        issue: `Pi session history cannot be represented safely because entry '${entryId}' forms a parent cycle.`,
      };
    }
    if (duplicateIds.has(entryId)) {
      return {
        _tag: "Unsupported",
        issue: `Pi session history cannot be represented safely because entry id '${entryId}' is duplicated.`,
      };
    }
    const entry = entriesById.get(entryId);
    if (!entry) {
      return {
        _tag: "Unsupported",
        issue: `Pi session history cannot be represented safely because entry '${entryId}' is missing from the active branch.`,
      };
    }
    visited.add(entryId);
    branch.push(entry);
    if (entry.parentId === null) {
      entryId = null;
    } else {
      const parentId = nonEmpty(entry.parentId);
      if (!parentId) {
        return {
          _tag: "Unsupported",
          issue: `Pi session history entry '${entryId}' cannot be represented safely because its parent cursor is invalid.`,
        };
      }
      entryId = parentId;
    }
  }

  const turns: Array<PiTurnRecord> = [];
  for (const entry of branch.toReversed()) {
    if (entry.type !== "message") continue;
    const id = nonEmpty(entry.id);
    const message = entry.message;
    if (!id || !isRecord(message) || typeof message.role !== "string") {
      return {
        _tag: "Unsupported",
        issue: `Pi session history entry '${id ?? "<unknown>"}' cannot be represented safely because its message payload is invalid.`,
      };
    }
    if (message.role === "user") {
      turns.push({
        id: TurnId.make(id),
        items: [],
        userEntryId: id,
      });
    }
  }
  return { _tag: "Success", turns };
}

function toolItemType(toolName: string): "command_execution" | "file_change" | "dynamic_tool_call" {
  if (toolName === "bash") return "command_execution";
  if (toolName === "edit" || toolName === "write") return "file_change";
  return "dynamic_tool_call";
}

interface PiMcpToolIdentity {
  readonly server: string;
  readonly tool: string;
  readonly arguments: unknown;
}

function directMcpToolIdentity(
  toolName: string,
  args: unknown,
  serverNames: ReadonlySet<string>,
): PiMcpToolIdentity | undefined {
  const candidates = [...serverNames]
    .flatMap((server) => {
      const normalized = server.replaceAll("-", "_");
      const short = server.replace(/-?mcp$/i, "").replaceAll("-", "_") || "mcp";
      return [
        { server, prefix: `${normalized}_` },
        { server, prefix: `${short}_` },
        { server, prefix: `mcp__${normalized}_` },
      ];
    })
    .sort((left, right) => right.prefix.length - left.prefix.length);
  const match = candidates.find((candidate) => toolName.startsWith(candidate.prefix));
  if (!match) return undefined;
  const tool = nonEmpty(toolName.slice(match.prefix.length));
  return tool ? { server: match.server, tool, arguments: args } : undefined;
}

function mcpToolIdentity(
  toolName: string,
  args: unknown,
  result: unknown,
  serverNames: ReadonlySet<string>,
): PiMcpToolIdentity | undefined {
  const argsRecord = isRecord(args) ? args : undefined;
  const resultRecord = isRecord(result) ? result : undefined;
  const details = isRecord(resultRecord?.details) ? resultRecord.details : undefined;
  const resultServer = nonEmpty(details?.server);
  const resultTool = nonEmpty(details?.tool);
  if (resultServer && resultTool) {
    return {
      server: resultServer,
      tool: resultTool,
      arguments: toolName === "mcp" ? argsRecord?.args : args,
    };
  }
  if (toolName === "mcp") {
    const server = nonEmpty(argsRecord?.server) ?? resultServer;
    const tool = nonEmpty(argsRecord?.tool) ?? resultTool;
    return server && tool
      ? {
          server,
          tool,
          arguments: argsRecord?.args,
        }
      : undefined;
  }
  return directMcpToolIdentity(toolName, args, serverNames);
}

function mcpToolItem(
  toolCallId: string,
  identity: PiMcpToolIdentity,
  status: "inProgress" | "completed" | "failed",
  result?: unknown,
) {
  return {
    type: "mcpToolCall",
    id: toolCallId,
    server: identity.server,
    tool: identity.tool,
    arguments: identity.arguments,
    status,
    ...(result !== undefined ? { result } : {}),
  };
}

function toolRequestType(
  toolName: string,
):
  | "command_execution_approval"
  | "file_read_approval"
  | "file_change_approval"
  | "dynamic_tool_call" {
  if (toolName === "bash") return "command_execution_approval";
  if (toolName === "edit" || toolName === "write") return "file_change_approval";
  if (["read", "grep", "find", "ls"].includes(toolName)) return "file_read_approval";
  return "dynamic_tool_call";
}

function extractResultText(result: unknown): string | undefined {
  if (!isRecord(result) || !Array.isArray(result.content)) return undefined;
  const text = result.content
    .flatMap((entry) => (isRecord(entry) && typeof entry.text === "string" ? [entry.text] : []))
    .join("\n");
  return text.trim() ? text : undefined;
}

function parseBridgeMarker(title: string | undefined):
  | {
      readonly toolCallId?: string;
      readonly toolName: string;
      readonly input: unknown;
    }
  | undefined {
  if (!title?.startsWith(PI_PERMISSION_BRIDGE_MARKER)) return undefined;
  try {
    const decoded = JSON.parse(title.slice(PI_PERMISSION_BRIDGE_MARKER.length));
    if (!isRecord(decoded) || typeof decoded.toolName !== "string") return undefined;
    return {
      ...(typeof decoded.toolCallId === "string" ? { toolCallId: decoded.toolCallId } : {}),
      toolName: decoded.toolName,
      input: decoded.input,
    };
  } catch {
    return undefined;
  }
}

function parseMcpStatusMarker(statusText: string | undefined) {
  if (!statusText?.startsWith(PI_MCP_STATUS_BRIDGE_MARKER)) return undefined;
  try {
    return decodeMcpStatusSnapshot(
      JSON.parse(statusText.slice(PI_MCP_STATUS_BRIDGE_MARKER.length)),
    );
  } catch {
    return undefined;
  }
}

function answerAsString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.find((entry): entry is string => typeof entry === "string");
  }
  return undefined;
}

export function piApprovalExtensionResponse(
  piRequestId: string,
  decision: ProviderApprovalDecision,
):
  | { readonly id: string; readonly cancelled: true }
  | { readonly id: string; readonly value: string } {
  if (decision === "cancel") {
    return { id: piRequestId, cancelled: true };
  }
  return {
    id: piRequestId,
    value:
      decision === "accept"
        ? "Accept once"
        : decision === "acceptForSession"
          ? "Accept for session"
          : "Decline",
  };
}

export function makePiAdapter(settings: PiSettings, options: PiAdapterOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options.instanceId ?? ProviderInstanceId.make("piAgent");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const serverConfig = yield* ServerConfig;
    const sessions = new Map<ThreadId, PiSessionContext>();
    const unregisteredSessionScopes = new Map<ThreadId, Scope.Closeable>();
    const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const threadLocks = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runFork = Effect.runForkWith(yield* Effect.context<never>());

    const nextUuid = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to allocate Pi runtime identifier.",
            cause,
          }),
      ),
    );
    const stamp = Effect.all({
      eventId: Effect.map(nextUuid, EventId.make),
      createdAt: Effect.map(DateTime.now, DateTime.formatIso),
    });
    const offer = (event: ProviderRuntimeEvent) => PubSub.publish(runtimeEvents, event);
    const baseEvent = (ctx: PiSessionContext) => ({
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      threadId: ctx.threadId,
    });
    const raw = (payload: unknown, method?: string) => ({
      raw: {
        source: "pi.rpc" as const,
        ...(method ? { method } : {}),
        payload,
      },
    });

    const withThreadLock = <A, E>(
      threadId: ThreadId,
      effect: Effect.Effect<A, E>,
    ): Effect.Effect<A, E> =>
      Effect.gen(function* () {
        const lock = yield* SynchronizedRef.modifyEffect(threadLocks, (current) => {
          const existing = current.get(threadId);
          if (existing) return Effect.succeed([existing, current] as const);
          return Effect.map(Semaphore.make(1), (created) => {
            const next = new Map(current);
            next.set(threadId, created);
            return [created, next] as const;
          });
        });
        return yield* lock.withPermits(1)(effect);
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<PiSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      return ctx && !ctx.stopped
        ? Effect.succeed(ctx)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    };

    const appendItem = (ctx: PiSessionContext, turnId: TurnId, item: unknown) => {
      const turn = ctx.turns.find((candidate) => candidate.id === turnId);
      if (turn) turn.items.push(item);
    };

    const mapAdapterError = (method: string, cause: unknown): ProviderAdapterError => {
      if (
        isAdapterProcessError(cause) ||
        isAdapterRequestError(cause) ||
        isAdapterSessionClosedError(cause) ||
        isAdapterSessionNotFoundError(cause) ||
        isAdapterValidationError(cause)
      ) {
        return cause;
      }
      return new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail: cause instanceof Error ? cause.message : String(cause),
        cause,
      });
    };

    const takePendingUi = (
      ctx: PiSessionContext,
      requestId: ApprovalRequestId,
    ): PendingUi | undefined => {
      const pending = ctx.pendingUi.get(requestId);
      if (!pending) return undefined;
      ctx.pendingUi.delete(requestId);
      if (pending.timeoutHandle !== undefined) {
        clearTimeout(pending.timeoutHandle);
        pending.timeoutHandle = undefined;
      }
      return pending;
    };

    const emitPendingUiResolved = (
      ctx: PiSessionContext,
      pending: PendingUi,
      approvalDecision: ProviderApprovalDecision = "cancel",
    ) =>
      Effect.gen(function* () {
        const eventStamp = yield* stamp;
        if (pending.kind === "approval") {
          yield* offer({
            type: "request.resolved",
            ...eventStamp,
            ...baseEvent(ctx),
            turnId: ctx.activeTurnId,
            requestId: RuntimeRequestId.make(pending.requestId),
            payload: { requestType: pending.requestType, decision: approvalDecision },
          });
        } else {
          yield* offer({
            type: "user-input.resolved",
            ...eventStamp,
            ...baseEvent(ctx),
            turnId: ctx.activeTurnId,
            requestId: RuntimeRequestId.make(pending.requestId),
            payload: { answers: {} },
          });
        }
      });

    const schedulePendingUiTimeout = (
      ctx: PiSessionContext,
      pending: PendingUi,
      timeoutMs: number | undefined,
    ) => {
      if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return;
      pending.timeoutHandle = setTimeout(() => {
        const timedOut = takePendingUi(ctx, pending.requestId);
        if (!timedOut) return;
        runFork(emitPendingUiResolved(ctx, timedOut));
      }, timeoutMs);
    };

    const cancelPendingUi = (ctx: PiSessionContext) =>
      Effect.forEach(
        [...ctx.pendingUi.values()],
        (pending) =>
          Effect.gen(function* () {
            const active = takePendingUi(ctx, pending.requestId);
            if (!active) return;
            yield* ctx.runtime
              .respondToExtensionUi({ id: active.piRequestId, cancelled: true })
              .pipe(Effect.ignore);
            yield* emitPendingUiResolved(ctx, active);
          }),
        { discard: true },
      );

    const completeAssistantBlocks = (
      ctx: PiSessionContext,
      turnId: TurnId,
      status: "completed" | "failed",
    ) =>
      Effect.forEach(
        [...ctx.assistantBlocks.values()],
        (block) =>
          block.completed
            ? Effect.void
            : Effect.gen(function* () {
                block.completed = true;
                yield* offer({
                  type: "item.completed",
                  ...(yield* stamp),
                  ...baseEvent(ctx),
                  turnId,
                  itemId: block.itemId,
                  payload: { itemType: block.itemType, status },
                });
              }),
        { discard: true },
      );

    const refreshResumeCursor = (ctx: PiSessionContext) =>
      Effect.gen(function* () {
        const state = yield* ctx.runtime.getState();
        if (!state.sessionFile?.trim()) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "get_state",
            detail: "Pi did not return a persistent session file.",
          });
        }
        const resumeCursor: PiRpcResumeCursor = {
          schemaVersion: 1,
          sessionFile: state.sessionFile,
          sessionId: state.sessionId,
        };
        ctx.session = {
          ...ctx.session,
          resumeCursor,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        };
        return resumeCursor;
      });

    const applyModelSelection = (
      ctx: PiSessionContext,
      selection: ModelSelection,
    ): Effect.Effect<void, ProviderAdapterValidationError | PiRpcError> =>
      Effect.gen(function* () {
        const parsed = parsePiModelSlug(selection.model);
        if (!parsed) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `Invalid Pi model slug '${selection.model}'. Expected <provider>/<model-id>.`,
          });
        }

        const desiredModelSlug = `${parsed.provider}/${parsed.modelId}`;
        const currentModel = ctx.currentModel;
        const modelChanged = !currentModel || piModelSlug(currentModel) !== desiredModelSlug;
        let selectedModel: PiModel;
        if (modelChanged) {
          selectedModel = yield* ctx.runtime.setModel(parsed.provider, parsed.modelId);
          ctx.currentModel = selectedModel;
        } else {
          selectedModel = currentModel;
        }

        const thinking = clampPiThinkingLevel(
          getModelSelectionStringOptionValue(selection, "thinkingLevel"),
          selectedModel,
          ctx.currentThinkingLevel,
        );
        if (modelChanged || thinking !== ctx.currentThinkingLevel) {
          yield* ctx.runtime.setThinkingLevel(thinking);
          ctx.currentThinkingLevel = thinking;
        }
      });

    const settleTurn = (
      ctx: PiSessionContext,
      state: "completed" | "failed" | "interrupted",
      errorMessage?: string,
    ) =>
      Effect.gen(function* () {
        const turnId = ctx.activeTurnId;
        if (!turnId || ctx.settledTurns.has(turnId)) return;
        ctx.settledTurns.add(turnId);
        yield* completeAssistantBlocks(ctx, turnId, state === "completed" ? "completed" : "failed");
        if (state === "interrupted") {
          yield* offer({
            type: "turn.aborted",
            ...(yield* stamp),
            ...baseEvent(ctx),
            turnId,
            payload: { reason: errorMessage || "Turn interrupted." },
          });
        } else {
          yield* offer({
            type: "turn.completed",
            ...(yield* stamp),
            ...baseEvent(ctx),
            turnId,
            payload: {
              state: state === "completed" ? "completed" : "failed",
              ...(ctx.finalStopReason ? { stopReason: ctx.finalStopReason } : {}),
              ...(errorMessage ? { errorMessage } : {}),
            },
          });
        }
        yield* refreshResumeCursor(ctx).pipe(Effect.ignore);
        ctx.activeTurnId = undefined;
        ctx.interruptingTurnId = undefined;
        ctx.finalStopReason = undefined;
        ctx.finalErrorMessage = undefined;
        ctx.activeAssistantMessageSequence = undefined;
        ctx.assistantBlocks.clear();
        const { activeTurnId: _activeTurnId, ...readySession } = ctx.session;
        ctx.session = {
          ...readySession,
          status: "ready",
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        };
        yield* offer({
          type: "thread.state.changed",
          ...(yield* stamp),
          ...baseEvent(ctx),
          payload: { state: "idle" },
        });
      });

    const openAssistantBlock = (
      ctx: PiSessionContext,
      turnId: TurnId,
      messageSequence: number,
      kind: "assistant_message" | "reasoning",
      contentIndex: number,
    ) =>
      Effect.gen(function* () {
        const key = `${messageSequence}:${kind}:${contentIndex}`;
        const existing = ctx.assistantBlocks.get(key);
        if (existing) return existing;
        const itemId = RuntimeItemId.make(
          `${turnId}-message-${messageSequence}-${kind}-${contentIndex}`,
        );
        const block: AssistantBlock = { itemId, itemType: kind, completed: false };
        ctx.assistantBlocks.set(key, block);
        const item = {
          id: itemId,
          type: kind,
          status: "inProgress",
        };
        appendItem(ctx, turnId, item);
        yield* offer({
          type: "item.started",
          ...(yield* stamp),
          ...baseEvent(ctx),
          turnId,
          itemId,
          payload: { itemType: kind, status: "inProgress" },
        });
        return block;
      });

    const emitUsage = (
      ctx: PiSessionContext,
      message: Record<string, unknown>,
      rawPayload: unknown,
      messageSequence: number,
    ) =>
      Effect.gen(function* () {
        if (message.role !== "assistant" || !isRecord(message.usage)) return;
        const usage = message.usage;
        const tokenCount = (value: unknown) =>
          typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
        const input = tokenCount(usage.input);
        const output = tokenCount(usage.output);
        const cacheRead = tokenCount(usage.cacheRead);
        const cacheWrite = tokenCount(usage.cacheWrite);
        const reasoningOutput =
          typeof usage.reasoning === "number"
            ? tokenCount(usage.reasoning)
            : typeof usage.reasoningOutput === "number"
              ? tokenCount(usage.reasoningOutput)
              : 0;
        const inputTokens = input + cacheRead + cacheWrite;
        const usedTokens = inputTokens + output;
        const lastUsage: PiAssistantTokenUsage = {
          usedTokens,
          inputTokens,
          cachedInputTokens: cacheRead,
          outputTokens: output,
          reasoningOutputTokens: reasoningOutput,
        };
        ctx.assistantUsageByMessage.set(messageSequence, lastUsage);
        const totalProcessedTokens = [...ctx.assistantUsageByMessage.values()].reduce(
          (total, current) => total + current.usedTokens,
          0,
        );
        const state = yield* ctx.runtime.getState().pipe(Effect.orElseSucceed(() => undefined));
        yield* offer({
          type: "thread.token-usage.updated",
          ...(yield* stamp),
          ...baseEvent(ctx),
          turnId: ctx.activeTurnId,
          payload: {
            usage: {
              usedTokens,
              totalProcessedTokens,
              inputTokens,
              cachedInputTokens: cacheRead,
              outputTokens: output,
              ...(reasoningOutput > 0 ? { reasoningOutputTokens: reasoningOutput } : {}),
              lastUsedTokens: usedTokens,
              lastInputTokens: inputTokens,
              lastCachedInputTokens: cacheRead,
              lastOutputTokens: output,
              ...(reasoningOutput > 0 ? { lastReasoningOutputTokens: reasoningOutput } : {}),
              toolUses: ctx.toolUses,
              ...(state?.model?.contextWindow ? { maxTokens: state.model.contextWindow } : {}),
              compactsAutomatically: state?.autoCompactionEnabled ?? true,
            },
          },
          ...raw(rawPayload, "message_end"),
        });
      });

    const handleExtensionUi = (ctx: PiSessionContext, event: PiRpcEvent, rawPayload: unknown) =>
      Effect.gen(function* () {
        const piRequestId = event.id;
        if (!piRequestId || !event.method) return;
        if (event.method === "setStatus") {
          const status = parseMcpStatusMarker(event.statusText);
          if (event.statusKey === "t3-mcp-status" && status) {
            ctx.mcpServerNames.clear();
            for (const server of status.servers) ctx.mcpServerNames.add(server.name);
            yield* offer({
              type: "mcp.status.updated",
              ...(yield* stamp),
              ...baseEvent(ctx),
              turnId: ctx.activeTurnId,
              payload: { status },
              ...raw(rawPayload, "extension_ui_request"),
            });
          }
          return;
        }
        if (["setWidget", "setTitle", "set_editor_text"].includes(event.method)) return;
        if (event.method === "notify") {
          const message = nonEmpty(event.message);
          if (message) {
            yield* offer({
              type: event.notifyType === "error" ? "runtime.error" : "runtime.warning",
              ...(yield* stamp),
              ...baseEvent(ctx),
              turnId: ctx.activeTurnId,
              payload:
                event.notifyType === "error"
                  ? { class: "provider_error", message }
                  : { message, detail: { code: "pi_extension_notification" } },
              ...raw(rawPayload, "extension_ui_request"),
            } as ProviderRuntimeEvent);
          }
          return;
        }

        const marker = parseBridgeMarker(nonEmpty(event.title));
        const requestId = ApprovalRequestId.make(piRequestId);
        if (event.method === "select" && marker) {
          const requestType = toolRequestType(marker.toolName);
          const pending: PendingUi = {
            kind: "approval",
            piRequestId,
            requestId,
            requestType,
            timeoutHandle: undefined,
          };
          ctx.pendingUi.set(requestId, pending);
          schedulePendingUiTimeout(ctx, pending, event.timeout);
          yield* offer({
            type: "request.opened",
            ...(yield* stamp),
            ...baseEvent(ctx),
            turnId: ctx.activeTurnId,
            itemId: marker.toolCallId ? RuntimeItemId.make(marker.toolCallId) : undefined,
            requestId: RuntimeRequestId.make(requestId),
            payload: {
              requestType,
              detail: `${marker.toolName} requires approval. Accept for session allows future ${marker.toolName} calls for this Pi process.`,
              args: marker.input,
            },
            ...raw(rawPayload, "extension_ui_request"),
          });
          return;
        }

        if (!["select", "confirm", "input", "editor"].includes(event.method)) return;
        const method = event.method as "select" | "confirm" | "input" | "editor";
        const questionId = "answer";
        const title = nonEmpty(event.title) ?? "Pi Agent request";
        const options =
          method === "select"
            ? (event.options ?? []).map((label) => ({
                label,
                description: `Select ${label}`,
              }))
            : method === "confirm"
              ? [
                  { label: "Yes", description: "Confirm this action" },
                  { label: "No", description: "Do not confirm this action" },
                ]
              : [];
        const pending: PendingUi = {
          kind: "user-input",
          piRequestId,
          requestId,
          method,
          questionId,
          timeoutHandle: undefined,
        };
        ctx.pendingUi.set(requestId, pending);
        schedulePendingUiTimeout(ctx, pending, event.timeout);
        yield* offer({
          type: "user-input.requested",
          ...(yield* stamp),
          ...baseEvent(ctx),
          turnId: ctx.activeTurnId,
          requestId: RuntimeRequestId.make(requestId),
          payload: {
            questions: [
              {
                id: questionId,
                header: method === "editor" ? "Editor" : method === "input" ? "Input" : "Choose",
                question:
                  method === "confirm" && nonEmpty(event.message)
                    ? `${title}\n${nonEmpty(event.message)}`
                    : title,
                options,
                ...(event.placeholder !== undefined ? { placeholder: event.placeholder } : {}),
                ...(event.prefill !== undefined ? { prefill: event.prefill } : {}),
                multiSelect: false,
              },
            ],
          },
          ...raw(rawPayload, "extension_ui_request"),
        });
      });

    const handleNativeEvent = (ctx: PiSessionContext, event: PiRpcEvent, rawPayload: unknown) =>
      Effect.gen(function* () {
        if (event.type === "extension_ui_request") {
          return yield* handleExtensionUi(ctx, event, rawPayload);
        }
        const turnId = ctx.activeTurnId;
        switch (event.type) {
          case "entry_appended": {
            if (!turnId) return;
            const turn = ctx.turns.find((candidate) => candidate.id === turnId);
            if (!turn) return;
            turn.hasSessionEntries = true;
            const entry = event.entry;
            if (!isRecord(entry) || entry.type !== "message") return;
            const entryId = nonEmpty(entry.id);
            const message = entry.message;
            if (
              turn.userEntryId === undefined &&
              entryId !== undefined &&
              isRecord(message) &&
              message.role === "user"
            ) {
              turn.userEntryId = entryId;
            }
            return;
          }
          case "session_info_changed": {
            const name = nonEmpty(event.name);
            yield* offer({
              type: "thread.metadata.updated",
              ...(yield* stamp),
              ...baseEvent(ctx),
              payload: {
                ...(name ? { name } : {}),
                metadata: {
                  ...(isResumeCursor(ctx.session.resumeCursor)
                    ? { sessionId: ctx.session.resumeCursor.sessionId }
                    : {}),
                  sessionName: name ?? null,
                },
              },
              ...raw(rawPayload, event.type),
            });
            return;
          }
          case "thinking_level_changed":
            if (event.level) ctx.currentThinkingLevel = event.level;
            return;
          case "agent_start":
            if (!turnId) return;
            ctx.session = {
              ...ctx.session,
              status: "running",
              updatedAt: DateTime.formatIso(yield* DateTime.now),
            };
            yield* offer({
              type: "thread.state.changed",
              ...(yield* stamp),
              ...baseEvent(ctx),
              turnId,
              payload: { state: "active" },
              ...raw(rawPayload, event.type),
            });
            return;
          case "message_start":
            if (turnId && isRecord(event.message) && event.message.role === "assistant") {
              ctx.assistantMessageSequence += 1;
              ctx.activeAssistantMessageSequence = ctx.assistantMessageSequence;
            }
            return;
          case "message_update": {
            if (!turnId || !isRecord(event.assistantMessageEvent)) return;
            const deltaEvent = event.assistantMessageEvent;
            const deltaType = deltaEvent.type;
            if (deltaType === "error") {
              ctx.finalStopReason = nonEmpty(deltaEvent.reason) ?? "error";
              if (isRecord(deltaEvent.error)) {
                ctx.finalErrorMessage =
                  nonEmpty(deltaEvent.error.errorMessage) ?? ctx.finalErrorMessage;
              }
              return;
            }
            if (deltaType !== "text_delta" && deltaType !== "thinking_delta") return;
            const delta = typeof deltaEvent.delta === "string" ? deltaEvent.delta : "";
            if (!delta) return;
            const contentIndex =
              typeof deltaEvent.contentIndex === "number" ? deltaEvent.contentIndex : 0;
            const itemType = deltaType === "text_delta" ? "assistant_message" : "reasoning";
            const messageSequence =
              ctx.activeAssistantMessageSequence ??
              (() => {
                ctx.assistantMessageSequence += 1;
                ctx.activeAssistantMessageSequence = ctx.assistantMessageSequence;
                return ctx.assistantMessageSequence;
              })();
            const block = yield* openAssistantBlock(
              ctx,
              turnId,
              messageSequence,
              itemType,
              contentIndex,
            );
            yield* offer({
              type: "content.delta",
              ...(yield* stamp),
              ...baseEvent(ctx),
              turnId,
              itemId: block.itemId,
              payload: {
                streamKind: deltaType === "text_delta" ? "assistant_text" : "reasoning_text",
                delta,
                contentIndex,
              },
              ...raw(rawPayload, event.type),
            });
            return;
          }
          case "message_end":
            if (isRecord(event.message)) {
              const message = event.message;
              if (message.role === "assistant") {
                ctx.finalStopReason = nonEmpty(message.stopReason) ?? ctx.finalStopReason;
                ctx.finalErrorMessage = nonEmpty(message.errorMessage) ?? ctx.finalErrorMessage;
                if (ctx.assistantMessageSequence === 0) {
                  ctx.assistantMessageSequence = 1;
                }
                yield* emitUsage(
                  ctx,
                  message,
                  rawPayload,
                  ctx.activeAssistantMessageSequence ?? ctx.assistantMessageSequence,
                );
                ctx.activeAssistantMessageSequence = undefined;
              }
            }
            return;
          case "tool_execution_start": {
            if (!turnId || !event.toolCallId || !event.toolName) return;
            ctx.toolUses += 1;
            const mcpIdentity = mcpToolIdentity(
              event.toolName,
              event.args,
              undefined,
              ctx.mcpServerNames,
            );
            const itemType = mcpIdentity ? "mcp_tool_call" : toolItemType(event.toolName);
            const title = mcpIdentity
              ? `${mcpIdentity.server} · ${mcpIdentity.tool}`
              : event.toolName;
            const data = mcpIdentity
              ? {
                  item: mcpToolItem(event.toolCallId, mcpIdentity, "inProgress"),
                }
              : { args: event.args };
            const item = {
              id: event.toolCallId,
              type: itemType,
              toolName: event.toolName,
              args: event.args,
            };
            appendItem(ctx, turnId, item);
            yield* offer({
              type: "item.started",
              ...(yield* stamp),
              ...baseEvent(ctx),
              turnId,
              itemId: RuntimeItemId.make(event.toolCallId),
              payload: {
                itemType,
                status: "inProgress",
                title,
                data,
              },
              ...raw(rawPayload, event.type),
            });
            return;
          }
          case "tool_execution_update":
          case "tool_execution_end": {
            if (!turnId || !event.toolCallId || !event.toolName) return;
            const result =
              event.type === "tool_execution_update" ? event.partialResult : event.result;
            const detail = extractResultText(result);
            const mcpIdentity = mcpToolIdentity(
              event.toolName,
              event.args,
              result,
              ctx.mcpServerNames,
            );
            const itemType = mcpIdentity ? "mcp_tool_call" : toolItemType(event.toolName);
            const status =
              event.type === "tool_execution_end"
                ? event.isError
                  ? "failed"
                  : "completed"
                : "inProgress";
            const title = mcpIdentity
              ? `${mcpIdentity.server} · ${mcpIdentity.tool}`
              : event.toolName;
            const data = mcpIdentity
              ? {
                  item: mcpToolItem(event.toolCallId, mcpIdentity, status, result),
                }
              : { args: event.args, result };
            yield* offer({
              type: event.type === "tool_execution_end" ? "item.completed" : "item.updated",
              ...(yield* stamp),
              ...baseEvent(ctx),
              turnId,
              itemId: RuntimeItemId.make(event.toolCallId),
              payload: {
                itemType,
                status,
                title,
                ...(detail ? { detail } : {}),
                data,
              },
              ...raw(rawPayload, event.type),
            });
            return;
          }
          case "compaction_start":
          case "compaction_end": {
            if (!turnId) return;
            const itemId = RuntimeItemId.make(`${turnId}-compaction`);
            yield* offer({
              type: event.type === "compaction_start" ? "item.started" : "item.completed",
              ...(yield* stamp),
              ...baseEvent(ctx),
              turnId,
              itemId,
              payload: {
                itemType: "context_compaction",
                status: event.type === "compaction_start" ? "inProgress" : "completed",
                title: "Context compaction",
              },
              ...raw(rawPayload, event.type),
            });
            return;
          }
          case "auto_retry_start":
          case "auto_retry_end":
          case "summarization_retry_scheduled":
          case "summarization_retry_attempt_start":
          case "summarization_retry_finished":
            yield* offer({
              type: "runtime.warning",
              ...(yield* stamp),
              ...baseEvent(ctx),
              turnId,
              payload: {
                message: `Pi Agent: ${event.type.replaceAll("_", " ")}.`,
                detail: { code: event.type },
              },
              ...raw(rawPayload, event.type),
            });
            return;
          case "extension_error":
            yield* offer({
              type: "runtime.error",
              ...(yield* stamp),
              ...baseEvent(ctx),
              turnId,
              payload: {
                class: "provider_error",
                message: nonEmpty(event.error) ?? "A Pi extension failed.",
              },
              ...raw(rawPayload, event.type),
            });
            return;
          case "agent_settled": {
            if (!turnId) return;
            if (ctx.interruptingTurnId === turnId) {
              return yield* settleTurn(ctx, "interrupted", "Turn interrupted by user.");
            }
            const reason = ctx.finalStopReason;
            if (reason === "aborted") return yield* settleTurn(ctx, "interrupted", "Turn aborted.");
            if (reason === "error")
              return yield* settleTurn(
                ctx,
                "failed",
                ctx.finalErrorMessage ?? "Pi Agent turn failed.",
              );
            return yield* settleTurn(ctx, "completed");
          }
          default:
            return;
        }
      });

    const stopSessionInternal = (ctx: PiSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* cancelPendingUi(ctx);
        ctx.unsubscribeEvent?.();
        ctx.unsubscribeExit?.();
        yield* ctx.runtime.close.pipe(Effect.timeoutOption("2 seconds"), Effect.ignore);
        sessions.delete(ctx.threadId);
        yield* offer({
          type: "session.exited",
          ...(yield* stamp),
          ...baseEvent(ctx),
          payload: { exitKind: "graceful" },
        });
        yield* Queue.shutdown(ctx.eventQueue);
        yield* Scope.close(ctx.scope, Exit.void).pipe(Effect.ignore);
      });

    const handleSignal = (ctx: PiSessionContext, signal: PiSessionSignal) => {
      switch (signal.type) {
        case "event":
          return handleNativeEvent(ctx, signal.event, signal.raw).pipe(
            Effect.catch((cause) =>
              stamp.pipe(
                Effect.flatMap((eventStamp) =>
                  offer({
                    type: "runtime.error",
                    ...eventStamp,
                    ...baseEvent(ctx),
                    turnId: ctx.activeTurnId,
                    payload: {
                      class: "validation_error",
                      message: cause.message,
                    },
                  }),
                ),
              ),
            ),
          );
        case "settle-if-active":
          return (
            ctx.activeTurnId === signal.turnId ? settleTurn(ctx, "completed") : Effect.void
          ).pipe(
            Effect.ensuring(Deferred.succeed(signal.completion, undefined).pipe(Effect.asVoid)),
          );
        case "exit":
          return Effect.gen(function* () {
            if (ctx.stopped) return;
            if (
              ctx.activeTurnId === undefined &&
              (signal.code === 143 || signal.signal === "SIGTERM")
            ) {
              return yield* stopSessionInternal(ctx);
            }
            const message = `Pi Agent process exited unexpectedly (code ${signal.code ?? "null"}, signal ${signal.signal ?? "none"}).`;
            yield* cancelPendingUi(ctx);
            yield* settleTurn(ctx, "failed", message);
            ctx.session = {
              ...ctx.session,
              status: "error",
              lastError: message,
              updatedAt: DateTime.formatIso(yield* DateTime.now),
            };
            yield* offer({
              type: "runtime.error",
              ...(yield* stamp),
              ...baseEvent(ctx),
              payload: { class: "transport_error", message },
            });
            ctx.stopped = true;
            ctx.unsubscribeEvent?.();
            ctx.unsubscribeExit?.();
            sessions.delete(ctx.threadId);
            yield* offer({
              type: "session.exited",
              ...(yield* stamp),
              ...baseEvent(ctx),
              payload: { exitKind: "error", reason: message, recoverable: false },
            });
            yield* Queue.shutdown(ctx.eventQueue);
            yield* Scope.close(ctx.scope, Exit.void).pipe(Effect.ignore);
          });
      }
    };

    const settleAfterQueuedEvents = Effect.fn("PiAdapter.settleAfterQueuedEvents")(function* (
      ctx: PiSessionContext,
      turnId: TurnId,
    ) {
      const completion = yield* Deferred.make<void>();
      const enqueued = yield* Queue.offer(ctx.eventQueue, {
        type: "settle-if-active",
        turnId,
        completion,
      });
      if (!enqueued) return;
      const eventFiber = ctx.eventFiber;
      if (!eventFiber) return;
      yield* Deferred.await(completion).pipe(Effect.raceFirst(Fiber.join(eventFiber)));
    });

    const startSession: PiAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }
          if (input.resumeCursor !== undefined && !isResumeCursor(input.resumeCursor)) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "The persisted Pi resume cursor is invalid.",
            });
          }
          const resumeCursor = input.resumeCursor as PiRpcResumeCursor | undefined;
          if (
            resumeCursor &&
            !(yield* fileSystem
              .exists(resumeCursor.sessionFile)
              .pipe(Effect.orElseSucceed(() => false)))
          ) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `The persisted Pi session file is missing: ${resumeCursor.sessionFile}`,
            });
          }

          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) yield* stopSessionInternal(existing);
          const sessionScope = yield* Scope.make("sequential");
          unregisteredSessionScopes.set(input.threadId, sessionScope);

          const cwd = path.resolve(input.cwd.trim());
          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          const mcpBridgeEnabled = mcpSession !== undefined && options.mcpBridge.available;
          const runtime = yield* makePiRpcSessionRuntime({
            binaryPath: settings.binaryPath || "pi",
            cwd,
            environment: {
              ...options.environment,
              T3_PI_RUNTIME_MODE: input.runtimeMode,
              ...(mcpBridgeEnabled
                ? {
                    [PI_MCP_ENDPOINT_ENV]: mcpSession.endpoint,
                    [PI_MCP_BEARER_TOKEN_ENV]: mcpSession.authorizationHeader.replace(
                      /^Bearer\s+/i,
                      "",
                    ),
                    [PI_MCP_BRIDGE_ENABLED_ENV]: "1",
                  }
                : {}),
            },
            agentDir: settings.agentDir,
            launchArgs: settings.launchArgs,
            trustProjectResources: settings.trustProjectResources,
            ...(resumeCursor ? { resumeCursor } : {}),
            extensionPath: options.extensionPath,
            ...(mcpBridgeEnabled ? { mcpConfigPath: options.mcpBridge.configPath } : {}),
          }).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );

          let state = yield* runtime.getState().pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          if (resumeCursor && state.sessionId !== resumeCursor.sessionId) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Pi resumed session '${state.sessionId}' instead of '${resumeCursor.sessionId}'.`,
            });
          }

          const selection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          if (selection) {
            const parsed = parsePiModelSlug(selection.model);
            if (!parsed) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "startSession",
                issue: `Invalid Pi model slug '${selection.model}'. Expected <provider>/<model-id>.`,
              });
            }
            const selectedModel = yield* runtime.setModel(parsed.provider, parsed.modelId);
            const thinking = clampPiThinkingLevel(
              getModelSelectionStringOptionValue(selection, "thinkingLevel"),
              selectedModel,
              state.thinkingLevel,
            );
            yield* runtime.setThinkingLevel(thinking);
            state = yield* runtime.getState();
          }
          if (!state.sessionFile?.trim()) {
            return yield* new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: "Pi did not create a persistent session file.",
            });
          }
          let turns: Array<PiTurnRecord> = [];
          if (resumeCursor) {
            const history = yield* runtime.getEntries().pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterProcessError({
                    provider: PROVIDER,
                    threadId: input.threadId,
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
            const rehydrated = rehydratePiTurnRecords(history);
            if (rehydrated._tag === "Unsupported") {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "startSession",
                issue: rehydrated.issue,
              });
            }
            turns = rehydrated.turns;
          }

          const now = DateTime.formatIso(yield* DateTime.now);
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            ...(state.model ? { model: `${state.model.provider}/${state.model.id}` } : {}),
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: 1,
              sessionFile: state.sessionFile,
              sessionId: state.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };
          const eventQueue = yield* Queue.unbounded<PiSessionSignal>();
          const ctx: PiSessionContext = {
            session,
            threadId: input.threadId,
            scope: sessionScope,
            runtime,
            eventQueue,
            eventFiber: undefined,
            unsubscribeEvent: undefined,
            unsubscribeExit: undefined,
            pendingUi: new Map(),
            assistantBlocks: new Map(),
            assistantUsageByMessage: new Map(),
            assistantMessageSequence: 0,
            activeAssistantMessageSequence: undefined,
            turns,
            activeTurnId: undefined,
            interruptingTurnId: undefined,
            finalStopReason: undefined,
            mcpServerNames: new Set(mcpBridgeEnabled ? ["t3-code"] : []),
            finalErrorMessage: undefined,
            toolUses: 0,
            currentModel: state.model ?? undefined,
            currentThinkingLevel: state.thinkingLevel,
            stopped: false,
            settledTurns: new Set(),
          };
          sessions.set(input.threadId, ctx);
          unregisteredSessionScopes.delete(input.threadId);
          ctx.unsubscribeEvent = runtime.onEvent((event, rawPayload) => {
            Queue.offerUnsafe(eventQueue, { type: "event", event, raw: rawPayload });
          });
          ctx.unsubscribeExit = runtime.onExit((exit) => {
            Queue.offerUnsafe(eventQueue, { type: "exit", ...exit });
          });
          yield* offer({
            type: "session.started",
            ...(yield* stamp),
            ...baseEvent(ctx),
            payload: { resume: session.resumeCursor },
          });
          yield* offer({
            type: "thread.started",
            ...(yield* stamp),
            ...baseEvent(ctx),
            payload: { providerThreadId: state.sessionId },
          });
          const sessionName = nonEmpty(state.sessionName);
          if (sessionName) {
            yield* offer({
              type: "thread.metadata.updated",
              ...(yield* stamp),
              ...baseEvent(ctx),
              payload: {
                name: sessionName,
                metadata: {
                  sessionId: state.sessionId,
                  sessionName,
                },
              },
            });
          }
          if (input.runtimeMode === "auto") {
            yield* offer({
              type: "runtime.warning",
              ...(yield* stamp),
              ...baseEvent(ctx),
              payload: {
                message:
                  "Pi Agent has no native automatic permission classifier; Auto mode requests approval for every tool.",
                detail: { code: "pi_auto_requires_approval" },
              },
            });
          }
          if (mcpSession && !options.mcpBridge.available) {
            yield* offer({
              type: "runtime.warning",
              ...(yield* stamp),
              ...baseEvent(ctx),
              payload: {
                message: options.mcpBridge.message,
                detail: {
                  code: "pi_mcp_bridge_unavailable",
                  reason: options.mcpBridge.reason,
                },
              },
            });
          }
          ctx.eventFiber = yield* Stream.fromQueue(eventQueue).pipe(
            Stream.runForEach((signal) => handleSignal(ctx, signal)),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : Effect.logError("Pi event stream failed", cause),
            ),
            Effect.forkIn(sessionScope),
          );
          return { ...ctx.session };
        }).pipe(
          Effect.mapError((cause) => mapAdapterError("startSession", cause)),
          Effect.onError(() => {
            const scope = unregisteredSessionScopes.get(input.threadId);
            unregisteredSessionScopes.delete(input.threadId);
            return scope === undefined ? Effect.void : Scope.close(scope, Exit.void);
          }),
        ),
      );

    const sendTurn: PiAdapterShape["sendTurn"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(input.threadId);
          const text = input.input?.trim() ?? "";
          const images = yield* Effect.forEach(input.attachments ?? [], (attachment) =>
            Effect.gen(function* () {
              const attachmentPath = resolveAttachmentPath({
                attachmentsDir: serverConfig.attachmentsDir,
                attachment,
              });
              if (!attachmentPath) {
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "prompt",
                  detail: `Invalid attachment id '${attachment.id}'.`,
                });
              }
              const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "prompt",
                      detail: cause.message,
                      cause,
                    }),
                ),
              );
              return {
                type: "image" as const,
                data: Buffer.from(bytes).toString("base64"),
                mimeType: attachment.mimeType,
              };
            }),
          );
          if (!text && images.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Turn requires non-empty text or attachments.",
            });
          }

          const steering = ctx.activeTurnId !== undefined;
          const turnId = ctx.activeTurnId ?? TurnId.make(yield* nextUuid);
          const selection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          if (selection) {
            yield* applyModelSelection(ctx, selection);
          }

          if (!steering) {
            ctx.turns.push({ id: turnId, items: [] });
            ctx.toolUses = 0;
            ctx.finalStopReason = undefined;
            ctx.finalErrorMessage = undefined;
            ctx.assistantUsageByMessage.clear();
            ctx.assistantMessageSequence = 0;
            ctx.activeAssistantMessageSequence = undefined;
            ctx.assistantBlocks.clear();
          }

          const startingModel = piModelSlug(ctx.currentModel);
          if (!steering) {
            ctx.activeTurnId = turnId;
            ctx.session = {
              ...ctx.session,
              status: "running",
              activeTurnId: turnId,
              ...(startingModel ? { model: startingModel } : {}),
              updatedAt: DateTime.formatIso(yield* DateTime.now),
            };
            yield* offer({
              type: "turn.started",
              ...(yield* stamp),
              ...baseEvent(ctx),
              turnId,
              payload: {
                ...(startingModel ? { model: startingModel } : {}),
                effort: ctx.currentThinkingLevel,
              },
            });
          }

          const state = yield* Effect.gen(function* () {
            yield* ctx.runtime.prompt({
              message: text,
              images,
              ...(steering ? { streamingBehavior: "steer" as const } : {}),
            });
            return yield* ctx.runtime.getState();
          }).pipe(
            Effect.tapError((cause) =>
              steering ? Effect.void : settleTurn(ctx, "failed", cause.message),
            ),
          );
          ctx.currentModel = state.model ?? undefined;
          ctx.currentThinkingLevel = state.thinkingLevel;
          const model = piModelSlug(ctx.currentModel);
          if (ctx.activeTurnId === turnId) {
            ctx.session = {
              ...ctx.session,
              status: "running",
              activeTurnId: turnId,
              ...(model ? { model } : {}),
              updatedAt: DateTime.formatIso(yield* DateTime.now),
            };
          }
          if (!steering && !state.isStreaming && ctx.activeTurnId === turnId) {
            yield* settleAfterQueuedEvents(ctx, turnId);
          }
          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: ctx.session.resumeCursor,
          };
        }).pipe(Effect.mapError((cause) => mapAdapterError("prompt", cause))),
      );

    const interruptTurn: PiAdapterShape["interruptTurn"] = (threadId, requestedTurnId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          const turnId = requestedTurnId ?? ctx.activeTurnId;
          if (!turnId || ctx.settledTurns.has(turnId)) return;
          yield* cancelPendingUi(ctx);
          ctx.interruptingTurnId = turnId;
          yield* ctx.runtime.abort().pipe(
            Effect.tapError(() =>
              Effect.sync(() => {
                if (ctx.interruptingTurnId === turnId) ctx.interruptingTurnId = undefined;
              }),
            ),
          );
          yield* settleTurn(ctx, "interrupted", "Turn interrupted by user.");
        }).pipe(Effect.mapError((cause) => mapAdapterError("abort", cause))),
      );

    const respondToRequest: PiAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          const pending = ctx.pendingUi.get(requestId);
          if (!pending || pending.kind !== "approval") {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "extension_ui_response",
              detail: `Unknown Pi approval request '${requestId}'.`,
            });
          }
          const response = piApprovalExtensionResponse(pending.piRequestId, decision);
          yield* ctx.runtime.respondToExtensionUi(response).pipe(
            Effect.tapError(() => {
              const failed = takePendingUi(ctx, requestId);
              return failed ? emitPendingUiResolved(ctx, failed) : Effect.void;
            }),
          );
          if (!takePendingUi(ctx, requestId)) return;
          yield* offer({
            type: "request.resolved",
            ...(yield* stamp),
            ...baseEvent(ctx),
            turnId: ctx.activeTurnId,
            requestId: RuntimeRequestId.make(requestId),
            payload: { requestType: pending.requestType, decision },
          });
        }),
      ).pipe(Effect.mapError((cause) => mapAdapterError("extension_ui_response", cause)));

    const respondToUserInput: PiAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          const pending = ctx.pendingUi.get(requestId);
          if (!pending || pending.kind !== "user-input") {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "extension_ui_response",
              detail: `Unknown Pi user-input request '${requestId}'.`,
            });
          }
          const answer = answerAsString(answers[pending.questionId]);
          if (answer === undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "respondToUserInput",
              issue: `Missing answer for '${pending.questionId}'.`,
            });
          }
          yield* ctx.runtime
            .respondToExtensionUi(
              pending.method === "confirm"
                ? { id: pending.piRequestId, confirmed: answer.toLowerCase() === "yes" }
                : { id: pending.piRequestId, value: answer },
            )
            .pipe(
              Effect.tapError(() => {
                const failed = takePendingUi(ctx, requestId);
                return failed ? emitPendingUiResolved(ctx, failed) : Effect.void;
              }),
            );
          if (!takePendingUi(ctx, requestId)) return;
          yield* offer({
            type: "user-input.resolved",
            ...(yield* stamp),
            ...baseEvent(ctx),
            turnId: ctx.activeTurnId,
            requestId: RuntimeRequestId.make(requestId),
            payload: { answers },
          });
        }),
      ).pipe(Effect.mapError((cause) => mapAdapterError("extension_ui_response", cause)));

    const readThread: PiAdapterShape["readThread"] = (threadId) =>
      Effect.map(requireSession(threadId), (ctx) => ({ threadId, turns: ctx.turns }));

    const rollbackThread: PiAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          if (!Number.isInteger(numTurns) || numTurns < 1 || numTurns > ctx.turns.length) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "rollbackThread",
              issue: "numTurns must remove at least one existing turn.",
            });
          }
          if (ctx.activeTurnId || ctx.session.status === "running") {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "fork",
              detail: "Pi rollback requires the session to be idle.",
            });
          }
          const removedTurns = ctx.turns.slice(-numTurns);
          const firstDurableIndex = removedTurns.findIndex(
            (turn) => turn.userEntryId !== undefined,
          );
          const cursorlessPrefix =
            firstDurableIndex < 0 ? removedTurns : removedTurns.slice(0, firstDurableIndex);
          const unsafeCursorlessTurn = cursorlessPrefix.find(
            (turn) => turn.hasSessionEntries === true,
          );
          if (unsafeCursorlessTurn) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "fork",
              detail:
                "Pi rollback cannot remove session history that has no durable user entry cursor.",
            });
          }

          const firstDurableTurn =
            firstDurableIndex < 0 ? undefined : removedTurns[firstDurableIndex];
          if (firstDurableTurn?.userEntryId) {
            const result = yield* ctx.runtime.fork(firstDurableTurn.userEntryId);
            if (result.cancelled) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "fork",
                detail: "A Pi extension cancelled the rollback fork.",
              });
            }
            yield* refreshResumeCursor(ctx);
          }
          ctx.turns = ctx.turns.slice(0, -numTurns);
          return { threadId, turns: ctx.turns };
        }).pipe(Effect.mapError((cause) => mapAdapterError("fork", cause))),
      );

    const stopSession: PiAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(threadId, Effect.flatMap(requireSession(threadId), stopSessionInternal));
    const listSessions: PiAdapterShape["listSessions"] = () =>
      Effect.sync(() => [...sessions.values()].map((ctx) => ({ ...ctx.session })));
    const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });
    const stopAll: PiAdapterShape["stopAll"] = () =>
      Effect.forEach([...sessions.values()], stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(Effect.ignore, Effect.andThen(PubSub.shutdown(runtimeEvents))),
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEvents),
    } satisfies PiAdapterShape;
  });
}

export function piRuntimeModeNeedsApproval(mode: RuntimeMode, toolName: string): boolean {
  if (mode === "full-access") return false;
  if (
    mode === "auto-accept-edits" &&
    ["read", "grep", "find", "ls", "edit", "write"].includes(toolName)
  ) {
    return false;
  }
  return true;
}
