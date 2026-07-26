import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const PI_PERMISSION_BRIDGE_VERSION = 2;
export const PI_PERMISSION_BRIDGE_MARKER = "__T3_PI_APPROVAL_V1__:";

export const PI_PERMISSION_BRIDGE_SOURCE = `
const MARKER = ${JSON.stringify(PI_PERMISSION_BRIDGE_MARKER)};
const MCP_GUIDANCE = \`
T3 Code collaborative browser tools are available through the t3-code MCP server.
Use t3_code_preview_status first. If no automation-capable preview is attached, use
t3_code_preview_open before concluding that the browser is unavailable. Then use
t3_code_preview_navigate, t3_code_preview_snapshot, and the focused preview tools.
If direct preview tools are not visible, use the mcp tool to search for "preview".
\`;
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const EDIT_TOOLS = new Set(["edit", "write"]);

export default function (pi) {
  const approvedCategories = new Set();
  pi.on("before_agent_start", async (event) => {
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
