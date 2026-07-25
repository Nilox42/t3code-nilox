import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const PI_PERMISSION_BRIDGE_VERSION = 1;
export const PI_PERMISSION_BRIDGE_MARKER = "__T3_PI_APPROVAL_V1__:";

export const PI_PERMISSION_BRIDGE_SOURCE = `
const MARKER = ${JSON.stringify(PI_PERMISSION_BRIDGE_MARKER)};
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const EDIT_TOOLS = new Set(["edit", "write"]);

export default function (pi) {
  const approvedCategories = new Set();
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
