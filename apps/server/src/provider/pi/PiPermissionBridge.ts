import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const PI_PERMISSION_BRIDGE_VERSION = 3;
export const PI_PERMISSION_BRIDGE_MARKER = "__T3_PI_APPROVAL_V1__:";
export const PI_MCP_STATUS_BRIDGE_MARKER = "__T3_PI_MCP_STATUS_V1__:";

export const PI_PERMISSION_BRIDGE_SOURCE = `
const MARKER = ${JSON.stringify(PI_PERMISSION_BRIDGE_MARKER)};
const MCP_STATUS_MARKER = ${JSON.stringify(PI_MCP_STATUS_BRIDGE_MARKER)};
const MCP_STATUS_EVENT = "pi-mcp-adapter/status/v1";
const MCP_STATUS_KEY = "t3-mcp-status";
const MCP_GUIDANCE = \`
T3 Code collaborative browser tools are available through the t3-code MCP server.
Use t3_code_preview_status first. If no automation-capable preview is attached, use
t3_code_preview_open before concluding that the browser is unavailable. Then use
t3_code_preview_navigate, t3_code_preview_snapshot, and the focused preview tools.
If direct preview tools are not visible, use the mcp tool to search for "preview".
\`;
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const EDIT_TOOLS = new Set(["edit", "write"]);
const MCP_SERVER_STATUSES = new Set([
  "connected",
  "cached",
  "failed",
  "needs-auth",
  "not-connected",
  "disabled",
]);

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function sanitizeMcpStatus(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.servers)) {
    return undefined;
  }
  const version = nonNegativeInteger(snapshot.version);
  const totalTools = nonNegativeInteger(snapshot.totalTools);
  const totalResources = nonNegativeInteger(snapshot.totalResources);
  const connectedCount = nonNegativeInteger(snapshot.connectedCount);
  const disabledCount = nonNegativeInteger(snapshot.disabledCount);
  if (!version || totalTools === undefined || totalResources === undefined ||
      connectedCount === undefined || disabledCount === undefined) {
    return undefined;
  }
  const servers = [];
  for (const server of snapshot.servers) {
    if (!server || typeof server !== "object") return undefined;
    const name = typeof server.name === "string" ? server.name.trim() : "";
    const status = server.status;
    const toolCount = nonNegativeInteger(server.toolCount);
    if (!name || !MCP_SERVER_STATUSES.has(status) || toolCount === undefined ||
        typeof server.disabled !== "boolean") {
      return undefined;
    }
    const resourceCount = nonNegativeInteger(server.resourceCount);
    const failedAgoSeconds = nonNegativeInteger(server.failedAgoSeconds);
    servers.push({
      name,
      status,
      toolCount,
      ...(resourceCount !== undefined ? { resourceCount } : {}),
      ...(failedAgoSeconds !== undefined ? { failedAgoSeconds } : {}),
      disabled: server.disabled,
    });
  }
  return {
    version,
    servers,
    totalTools,
    totalResources,
    connectedCount,
    disabledCount,
  };
}

export default function (pi) {
  const approvedCategories = new Set();
  let sessionContext;
  let latestMcpStatus;
  const publishMcpStatus = (snapshot) => {
    const sanitized = sanitizeMcpStatus(snapshot);
    if (!sanitized) return;
    latestMcpStatus = sanitized;
    sessionContext?.ui.setStatus(
      MCP_STATUS_KEY,
      MCP_STATUS_MARKER + JSON.stringify(sanitized),
    );
  };
  pi.events?.on?.(MCP_STATUS_EVENT, publishMcpStatus);
  pi.on("session_start", async (_event, ctx) => {
    sessionContext = ctx;
    if (latestMcpStatus) publishMcpStatus(latestMcpStatus);
  });
  pi.on("before_agent_start", async (event, ctx) => {
    sessionContext = ctx;
    if (latestMcpStatus) publishMcpStatus(latestMcpStatus);
    if (process.env.T3_PI_MCP_BRIDGE_ENABLED !== "1") return undefined;
    return { systemPrompt: event.systemPrompt + "\\n\\n" + MCP_GUIDANCE.trim() };
  });
  pi.on("tool_call", async (event, ctx) => {
    const mode = process.env.T3_PI_RUNTIME_MODE || "approval-required";
    const category = event.toolName === "bash"
      ? "bash"
      : EDIT_TOOLS.has(event.toolName)
        ? "edit"
        : READ_TOOLS.has(event.toolName)
          ? "read"
          : "custom";
    if (mode === "full-access") return undefined;
    if (mode === "auto-accept-edits" && (category === "read" || category === "edit")) {
      return undefined;
    }
    if (approvedCategories.has(category)) return undefined;
    const marker = MARKER + JSON.stringify({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      category,
      input: event.input,
    });
    const choice = await ctx.ui.select(marker, [
      "Accept once",
      "Accept for session",
      "Decline",
    ]);
    if (choice === "Accept for session") {
      approvedCategories.add(category);
      return undefined;
    }
    if (choice === "Accept once") return undefined;
    return { block: true, reason: choice ? "Blocked by user" : "Cancelled by user" };
  });
}
`.trimStart();

export const materializePiPermissionBridge = Effect.fn("materializePiPermissionBridge")(function* (
  stateDir: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(stateDir, "pi", "extensions");
  const extensionPath = path.join(
    directory,
    `t3-permission-bridge-v${PI_PERMISSION_BRIDGE_VERSION}.mjs`,
  );
  yield* fileSystem.makeDirectory(directory, { recursive: true });
  const current = yield* fileSystem
    .readFileString(extensionPath)
    .pipe(Effect.orElseSucceed(() => ""));
  if (current !== PI_PERMISSION_BRIDGE_SOURCE) {
    yield* fileSystem.writeFileString(extensionPath, PI_PERMISSION_BRIDGE_SOURCE);
  }
  return extensionPath;
});
