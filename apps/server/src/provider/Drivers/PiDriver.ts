import { PiSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makePiTextGeneration } from "../../textGeneration/PiTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makePiAdapter } from "../Layers/PiAdapter.ts";
import {
  checkPiProviderStatus,
  makePendingPiProvider,
  stampPiProviderIdentity,
} from "../Layers/PiProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { materializePiPermissionBridge } from "../pi/PiPermissionBridge.ts";
import { resolvePiAgentDirectory } from "../pi/PiAgentDirectory.ts";
import type { ProviderDriver, ProviderInstance } from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { preparePiMcpBridge } from "../pi/PiMcpBridge.ts";

const DRIVER_KIND = ProviderDriverKind.make("piAgent");
const REFRESH_INTERVAL = Duration.minutes(5);
const decodeSettings = Schema.decodeSync(PiSettings);

const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "@earendil-works/pi-coding-agent",
  homebrewFormula: null,
  nativeUpdate: {
    executable: "pi",
    args: ["update", "--self"],
    lockKey: "pi-agent-native",
    isCommandPath: (commandPath) => {
      const normalized = normalizeCommandPath(commandPath);
      return (
        normalized.endsWith("/pi") ||
        normalized.endsWith("/pi.exe") ||
        normalized.endsWith("/pi.cmd")
      );
    },
  },
});

export type PiDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ServerConfig
  | ServerSettingsService;

export const PiDriver: ProviderDriver<PiSettings, PiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Pi Agent",
    supportsMultipleInstances: true,
  },
  configSchema: PiSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const httpClient = yield* HttpClient.HttpClient;
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const effectiveConfig = { ...config, enabled } satisfies PiSettings;
      const processEnvironment = mergeProviderInstanceEnvironment(environment);
      const agentDirectory = yield* resolvePiAgentDirectory(
        effectiveConfig,
        processEnvironment,
        serverConfig.cwd,
      );
      const runtimeConfig = {
        ...effectiveConfig,
        agentDir: agentDirectory.path,
      } satisfies PiSettings;
      const continuationKey = agentDirectory.continuationKey;
      const extensionPath = yield* materializePiPermissionBridge(serverConfig.stateDir).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to materialize the Pi approval bridge: ${cause.message}`,
              cause,
            }),
        ),
      );
      const mcpBridge = yield* preparePiMcpBridge({
        stateDir: serverConfig.stateDir,
        instanceId,
        settings: runtimeConfig,
        environment: processEnvironment,
      });
      const adapter = yield* makePiAdapter(runtimeConfig, {
        instanceId,
        environment: processEnvironment,
        extensionPath,
        mcpBridge,
      });
      const textGeneration = yield* makePiTextGeneration(runtimeConfig, processEnvironment);
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnvironment,
      });
      const stampIdentity = (snapshot: Parameters<typeof stampPiProviderIdentity>[0]) =>
        stampPiProviderIdentity(snapshot, {
          instanceId,
          ...(displayName ? { displayName } : {}),
          ...(accentColor ? { accentColor } : {}),
          continuationGroupKey: continuationKey,
        });
      const checkProvider = checkPiProviderStatus(
        runtimeConfig,
        serverConfig.cwd,
        processEnvironment,
        mcpBridge,
      ).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Crypto.Crypto, crypto),
      );
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<PiSettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          makePendingPiProvider(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
          enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
            enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
          }).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.flatMap(publishSnapshot),
          ),
        refreshInterval: REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Pi Agent snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity: {
          driverKind: DRIVER_KIND,
          continuationKey,
        },
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
