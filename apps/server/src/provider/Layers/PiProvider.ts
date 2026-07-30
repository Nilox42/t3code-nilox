import type {
  PiSettings,
  ServerProvider,
  ServerProviderModel,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  isCommandMissingCause,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  clampPiThinkingLevel,
  isSupportedPiVersion,
  makePiRpcSessionRuntime,
  parsePiVersion,
  PI_MINIMUM_VERSION,
  type PiRpcCommandInfo,
  type PiModel,
  type PiRpcState,
  supportedThinkingLevels,
} from "../pi/PiRpcSessionRuntime.ts";
import type { PiMcpBridgeCapability } from "../pi/PiMcpBridge.ts";

const PROVIDER = ProviderDriverKind.make("piAgent");
const VERSION_TIMEOUT_MS = 4_000;
const RPC_PROBE_TIMEOUT_MS = 15_000;
const PRESENTATION = {
  displayName: "Pi Agent",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
} as const;

const THINKING_LABELS: Record<string, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function buildPiModelCatalog(
  models: ReadonlyArray<PiModel>,
  state: PiRpcState,
): ReadonlyArray<ServerProviderModel> {
  const currentSlug = state.model ? `${state.model.provider}/${state.model.id}` : undefined;
  return models.map((model, index) => {
    const slug = `${model.provider}/${model.id}`;
    const levels = supportedThinkingLevels(model);
    const defaultThinking = clampPiThinkingLevel(
      slug === currentSlug ? state.thinkingLevel : undefined,
      model,
    );
    return {
      slug,
      name: model.name.trim() || model.id,
      subProvider: model.provider,
      isCustom: false,
      isDefault: currentSlug ? slug === currentSlug : index === 0,
      capabilities: {
        optionDescriptors: [
          buildSelectOptionDescriptor({
            id: "thinkingLevel",
            label: "Thinking level",
            options: levels.map((level) => ({
              value: level,
              label: THINKING_LABELS[level] ?? level,
              ...(level === defaultThinking ? { isDefault: true } : {}),
            })),
          }),
        ],
      },
    };
  });
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function commandSourceInfo(command: PiRpcCommandInfo): Record<string, unknown> | undefined {
  return typeof command.sourceInfo === "object" && command.sourceInfo !== null
    ? (command.sourceInfo as Record<string, unknown>)
    : undefined;
}

export function buildPiCommandCatalog(commands: ReadonlyArray<PiRpcCommandInfo>): {
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
} {
  const slashCommands: Array<ServerProviderSlashCommand> = [];
  const skills: Array<ServerProviderSkill> = [];
  const slashNames = new Set<string>();
  const skillNames = new Set<string>();

  for (const command of commands) {
    if (!["extension", "prompt", "skill"].includes(command.source)) continue;
    const name = nonEmpty(command.name);
    if (!name) continue;
    const description = nonEmpty(command.description);
    if (!slashNames.has(name)) {
      slashNames.add(name);
      slashCommands.push({ name, ...(description ? { description } : {}) });
    }

    if (command.source !== "skill") continue;
    const skillName = name.startsWith("skill:") ? nonEmpty(name.slice("skill:".length)) : name;
    if (!skillName || skillNames.has(skillName)) continue;
    const sourceInfo = commandSourceInfo(command);
    const path = nonEmpty(sourceInfo?.path) ?? nonEmpty(command.path) ?? nonEmpty(command.location);
    if (!path) continue;
    const scope = nonEmpty(sourceInfo?.scope);
    skillNames.add(skillName);
    skills.push({
      name: skillName,
      ...(description ? { description } : {}),
      path,
      ...(scope ? { scope } : {}),
      enabled: true,
    });
  }

  return { slashCommands, skills };
}

const runPiVersionCommand = Effect.fn("runPiVersionCommand")(function* (
  settings: PiSettings,
  environment?: NodeJS.ProcessEnv,
) {
  const binaryPath = settings.binaryPath || "pi";
  const spawn = yield* resolveSpawnCommand(
    binaryPath,
    ["--version"],
    environment ? { env: environment } : {},
  );
  return yield* spawnAndCollect(
    binaryPath,
    ChildProcess.make(spawn.command, spawn.args, {
      env: {
        ...process.env,
        ...environment,
        ...(settings.agentDir ? { PI_CODING_AGENT_DIR: settings.agentDir } : {}),
      },
      shell: spawn.shell,
    }),
  );
});

function unavailable(input: {
  settings: PiSettings;
  checkedAt: string;
  installed: boolean;
  version: string | null;
  message: string;
}): ServerProviderDraft {
  return buildServerProvider({
    driver: PROVIDER,
    presentation: PRESENTATION,
    enabled: input.settings.enabled,
    checkedAt: input.checkedAt,
    models: [],
    probe: {
      installed: input.installed,
      version: input.version,
      status: "error",
      auth: { status: "unknown" },
      message: input.message,
    },
  });
}

export function makePendingPiProvider(settings: PiSettings): Effect.Effect<ServerProviderDraft> {
  return Effect.map(DateTime.now, (now) =>
    buildServerProvider({
      driver: PROVIDER,
      presentation: PRESENTATION,
      enabled: settings.enabled,
      checkedAt: DateTime.formatIso(now),
      models: [],
      probe: settings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking Pi Agent availability...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Pi Agent is disabled in T3 Code settings.",
          },
    }),
  );
}

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  settings: PiSettings,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  mcpBridge?: PiMcpBridgeCapability,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) {
    return yield* makePendingPiProvider(settings);
  }

  const versionExit = yield* runPiVersionCommand(settings, environment).pipe(
    Effect.timeoutOption(VERSION_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionExit)) {
    return unavailable({
      settings,
      checkedAt,
      installed: !isCommandMissingCause(versionExit.failure),
      version: null,
      message: isCommandMissingCause(versionExit.failure)
        ? "Pi Agent CLI (`pi`) is not installed or not on PATH. Install @earendil-works/pi-coding-agent >= 0.82.0."
        : "Failed to execute `pi --version`.",
    });
  }
  if (Option.isNone(versionExit.success)) {
    return unavailable({
      settings,
      checkedAt,
      installed: true,
      version: null,
      message: "Pi Agent CLI timed out while running `pi --version`.",
    });
  }

  const commandResult = versionExit.success.value;
  const version = parsePiVersion(`${commandResult.stdout}\n${commandResult.stderr}`);
  if (commandResult.code !== 0) {
    return unavailable({
      settings,
      checkedAt,
      installed: true,
      version,
      message: `Pi Agent CLI failed its version check (exit code ${commandResult.code}).`,
    });
  }
  if (!version || !isSupportedPiVersion(version)) {
    return unavailable({
      settings,
      checkedAt,
      installed: true,
      version,
      message: `Pi Agent ${PI_MINIMUM_VERSION} or newer is required. Run \`pi update --self\` to upgrade.`,
    });
  }

  const probe = yield* Effect.gen(function* () {
    const runtime = yield* makePiRpcSessionRuntime({
      binaryPath: settings.binaryPath || "pi",
      cwd,
      ...(environment ? { environment } : {}),
      agentDir: settings.agentDir,
      launchArgs: settings.launchArgs,
      trustProjectResources: settings.trustProjectResources,
      noSession: true,
      noTools: true,
      requestTimeoutMs: RPC_PROBE_TIMEOUT_MS,
    });
    const [state, models, commands] = yield* Effect.all(
      [runtime.getState(), runtime.getAvailableModels(), runtime.getCommands()],
      { concurrency: "unbounded" },
    );
    return { state, models, commands };
  }).pipe(Effect.scoped, Effect.timeoutOption(RPC_PROBE_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(probe)) {
    return unavailable({
      settings,
      checkedAt,
      installed: true,
      version,
      message: "Pi Agent RPC startup failed. Check the Pi configuration and server logs.",
    });
  }
  if (Option.isNone(probe.success)) {
    return unavailable({
      settings,
      checkedAt,
      installed: true,
      version,
      message: "Pi Agent RPC model discovery timed out.",
    });
  }

  const { state, models, commands } = probe.success.value;
  const catalog = buildPiModelCatalog(models, state);
  const commandCatalog = buildPiCommandCatalog(commands);
  return buildServerProvider({
    driver: PROVIDER,
    presentation: PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: catalog,
    slashCommands: commandCatalog.slashCommands,
    skills: commandCatalog.skills,
    probe:
      models.length > 0
        ? mcpBridge && !mcpBridge.available
          ? {
              installed: true,
              version,
              status: "warning",
              auth: { status: "authenticated" },
              message: mcpBridge.message,
            }
          : {
              installed: true,
              version,
              status: "ready",
              auth: { status: "authenticated" },
              message: `Pi Agent ${version} is ready.`,
            }
        : {
            installed: true,
            version,
            status: "warning",
            auth: { status: "unauthenticated" },
            message:
              "No authenticated Pi models are available. Run Pi and use `/login`, then refresh.",
          },
  });
});

export function stampPiProviderIdentity(
  snapshot: ServerProviderDraft,
  input: {
    readonly instanceId: ServerProvider["instanceId"];
    readonly displayName?: string;
    readonly accentColor?: string;
    readonly continuationGroupKey: string;
  },
): ServerProvider {
  return {
    ...snapshot,
    instanceId: input.instanceId,
    driver: PROVIDER,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  };
}
