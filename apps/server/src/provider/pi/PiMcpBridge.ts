// @effect-diagnostics preferSchemaOverJson:off
import type { PiSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse, type ParseError } from "jsonc-parser";

import { expandHomePath } from "../../pathExpansion.ts";

const PI_MCP_ADAPTER_PACKAGE = "pi-mcp-adapter";
const T3_MCP_SERVER_NAME = "t3-code";

export const PI_MCP_ENDPOINT_ENV = "T3_MCP_ENDPOINT";
export const PI_MCP_BEARER_TOKEN_ENV = "T3_MCP_BEARER_TOKEN";
export const PI_MCP_BRIDGE_ENABLED_ENV = "T3_PI_MCP_BRIDGE_ENABLED";

export type PiMcpBridgeCapability =
  | {
      readonly available: true;
      readonly configPath: string;
    }
  | {
      readonly available: false;
      readonly reason: "adapter-not-installed" | "configuration-error";
      readonly message: string;
    };

export const PI_MCP_ADAPTER_REQUIRED_MESSAGE =
  "T3 collaborative browser tools are unavailable for Pi Agent because the compatible MCP adapter is not installed. Run `pi install npm:pi-mcp-adapter`, then restart T3 Code.";

const PI_MCP_CONFIGURATION_ERROR_MESSAGE =
  "T3 collaborative browser tools are unavailable for Pi Agent because its MCP bridge configuration could not be prepared. Check the server logs and Pi MCP configuration, then restart T3 Code.";

interface PreparePiMcpBridgeInput {
  readonly stateDir: string;
  readonly instanceId: ProviderInstanceId;
  readonly settings: Pick<PiSettings, "agentDir">;
  readonly environment?: NodeJS.ProcessEnv;
}

class PiMcpBridgeConfigurationError extends Data.TaggedError("PiMcpBridgeConfigurationError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsoncRecord(source: string, label: string): Record<string, unknown> {
  const errors: Array<ParseError> = [];
  const value: unknown = parse(source, errors, {
    allowEmptyContent: false,
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0 || !isRecord(value)) {
    throw new Error(`${label} is not a valid JSON object.`);
  }
  return value;
}

function isPiMcpAdapterPackage(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const packageReference = value.trim();
  return (
    packageReference === PI_MCP_ADAPTER_PACKAGE ||
    packageReference === `npm:${PI_MCP_ADAPTER_PACKAGE}` ||
    packageReference.startsWith(`${PI_MCP_ADAPTER_PACKAGE}@`) ||
    packageReference.startsWith(`npm:${PI_MCP_ADAPTER_PACKAGE}@`)
  );
}

function safeInstanceName(instanceId: ProviderInstanceId): string {
  const safe = String(instanceId).replaceAll(/[^a-zA-Z0-9._-]/g, "_");
  return safe || "piAgent";
}

function resolvePiAgentDir(
  path: Path.Path,
  settings: Pick<PiSettings, "agentDir">,
  environment?: NodeJS.ProcessEnv,
): string {
  const configured =
    settings.agentDir.trim() || environment?.PI_CODING_AGENT_DIR?.trim() || "~/.pi/agent";
  return path.resolve(expandHomePath(configured));
}

function mergeT3McpServer(config: Record<string, unknown>): Record<string, unknown> {
  const legacyServers = isRecord(config["mcp-servers"]) ? config["mcp-servers"] : {};
  const currentServers = isRecord(config.mcpServers) ? config.mcpServers : {};
  const { ["mcp-servers"]: _legacyServers, ...rest } = config;
  return {
    ...rest,
    mcpServers: {
      ...legacyServers,
      ...currentServers,
      [T3_MCP_SERVER_NAME]: {
        url: `\${${PI_MCP_ENDPOINT_ENV}}`,
        auth: "bearer",
        bearerTokenEnv: PI_MCP_BEARER_TOKEN_ENV,
        lifecycle: "eager",
        directTools: true,
        includeTools: ["preview_*"],
      },
    },
  };
}

export const preparePiMcpBridge = Effect.fn("preparePiMcpBridge")(function* (
  input: PreparePiMcpBridgeInput,
): Effect.fn.Return<PiMcpBridgeCapability, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const agentDir = resolvePiAgentDir(path, input.settings, input.environment);
  const settingsPath = path.join(agentDir, "settings.json");
  const packagePath = path.join(agentDir, "npm", "node_modules", PI_MCP_ADAPTER_PACKAGE);

  const settingsExists = yield* fileSystem
    .exists(settingsPath)
    .pipe(Effect.orElseSucceed(() => false));
  const packageExists = yield* fileSystem
    .exists(packagePath)
    .pipe(Effect.orElseSucceed(() => false));
  if (!settingsExists || !packageExists) {
    return {
      available: false,
      reason: "adapter-not-installed",
      message: PI_MCP_ADAPTER_REQUIRED_MESSAGE,
    };
  }

  const prepared = yield* Effect.gen(function* () {
    const settingsSource = yield* fileSystem.readFileString(settingsPath);
    const parsedSettings = yield* Effect.try({
      try: () => parseJsoncRecord(settingsSource, settingsPath),
      catch: (cause) =>
        new PiMcpBridgeConfigurationError({
          message: `Failed to parse ${settingsPath}.`,
          cause,
        }),
    });
    if (
      !Array.isArray(parsedSettings.packages) ||
      !parsedSettings.packages.some(isPiMcpAdapterPackage)
    ) {
      return {
        available: false,
        reason: "adapter-not-installed",
        message: PI_MCP_ADAPTER_REQUIRED_MESSAGE,
      } satisfies PiMcpBridgeCapability;
    }

    const userConfigPath = path.join(agentDir, "mcp.json");
    const userConfigExists = yield* fileSystem
      .exists(userConfigPath)
      .pipe(Effect.orElseSucceed(() => false));
    const userConfig = userConfigExists
      ? yield* fileSystem.readFileString(userConfigPath).pipe(
          Effect.flatMap((source) =>
            Effect.try({
              try: () => parseJsoncRecord(source, userConfigPath),
              catch: (cause) =>
                new PiMcpBridgeConfigurationError({
                  message: `Failed to parse ${userConfigPath}.`,
                  cause,
                }),
            }),
          ),
        )
      : {};
    const output = `${JSON.stringify(mergeT3McpServer(userConfig), null, 2)}\n`;
    const outputDirectory = path.join(input.stateDir, "pi", "mcp");
    const configPath = path.join(
      outputDirectory,
      `t3-browser-${safeInstanceName(input.instanceId)}.json`,
    );
    yield* fileSystem.makeDirectory(outputDirectory, { recursive: true });
    const current = yield* fileSystem
      .readFileString(configPath)
      .pipe(Effect.orElseSucceed(() => ""));
    if (current !== output) {
      yield* fileSystem.writeFileString(configPath, output);
    }
    return { available: true, configPath } satisfies PiMcpBridgeCapability;
  }).pipe(Effect.result);

  if (prepared._tag === "Success") return prepared.success;

  yield* Effect.logWarning("Failed to prepare the Pi MCP bridge.", {
    agentDir,
    cause: String(prepared.failure),
  });
  return {
    available: false,
    reason: "configuration-error",
    message: PI_MCP_CONFIGURATION_ERROR_MESSAGE,
  };
});
