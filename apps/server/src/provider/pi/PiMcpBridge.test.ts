// @effect-diagnostics preferSchemaOverJson:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { PI_MCP_ADAPTER_REQUIRED_MESSAGE, preparePiMcpBridge } from "./PiMcpBridge.ts";

const PI_INSTANCE = ProviderInstanceId.make("piAgent_test");

const makeLayout = Effect.fn("makePiMcpTestLayout")(function* (packageReference: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectory({ prefix: "pi-mcp-bridge-" });
  const agentDir = path.join(root, "agent");
  const stateDir = path.join(root, "state");
  yield* fileSystem.makeDirectory(path.join(agentDir, "npm", "node_modules", "pi-mcp-adapter"), {
    recursive: true,
  });
  yield* fileSystem.writeFileString(
    path.join(agentDir, "settings.json"),
    `{
      // Pi package references may be versioned.
      "packages": [${JSON.stringify(packageReference)}],
    }`,
  );
  return { agentDir, stateDir };
});

describe("Pi MCP bridge preparation", () => {
  it.effect("preserves Pi MCP settings and materializes a secret-free T3 browser server", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { agentDir, stateDir } = yield* makeLayout("npm:pi-mcp-adapter@2.15.0");
      yield* fileSystem.writeFileString(
        path.join(agentDir, "mcp.json"),
        `{
          "settings": { "directTools": false },
          "mcp-servers": {
            "existing": { "command": "existing-mcp" },
          },
        }`,
      );

      const result = yield* preparePiMcpBridge({
        stateDir,
        instanceId: PI_INSTANCE,
        settings: { agentDir },
        environment: { T3_MCP_BEARER_TOKEN: "must-not-be-written" },
      });

      expect(result.available).toBe(true);
      if (!result.available) return;
      const source = yield* fileSystem.readFileString(result.configPath);
      const config = JSON.parse(source) as {
        settings: { directTools: boolean };
        mcpServers: Record<string, Record<string, unknown>>;
      };
      expect(config.settings).toEqual({ directTools: false });
      expect(config.mcpServers.existing).toEqual({ command: "existing-mcp" });
      expect(config.mcpServers["t3-code"]).toEqual({
        url: "${T3_MCP_ENDPOINT}",
        auth: "bearer",
        bearerTokenEnv: "T3_MCP_BEARER_TOKEN",
        lifecycle: "eager",
        directTools: true,
        includeTools: ["preview_*"],
      });
      expect(source).not.toContain("must-not-be-written");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports an actionable warning when the adapter is not loaded by Pi", () =>
    Effect.gen(function* () {
      const { agentDir, stateDir } = yield* makeLayout("npm:some-other-extension");
      const result = yield* preparePiMcpBridge({
        stateDir,
        instanceId: PI_INSTANCE,
        settings: { agentDir },
      });

      expect(result).toEqual({
        available: false,
        reason: "adapter-not-installed",
        message: PI_MCP_ADAPTER_REQUIRED_MESSAGE,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps Pi usable when its existing MCP configuration is invalid", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { agentDir, stateDir } = yield* makeLayout("npm:pi-mcp-adapter");
      yield* fileSystem.writeFileString(path.join(agentDir, "mcp.json"), "{ invalid");

      const result = yield* preparePiMcpBridge({
        stateDir,
        instanceId: PI_INSTANCE,
        settings: { agentDir },
      });

      expect(result.available).toBe(false);
      if (result.available) return;
      expect(result.reason).toBe("configuration-error");
      expect(result.message).toMatch(/browser tools are unavailable/i);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
