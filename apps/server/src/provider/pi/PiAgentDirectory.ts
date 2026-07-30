import type { PiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";

export interface PiAgentDirectory {
  readonly path: string;
  readonly continuationKey: string;
}

export const resolvePiAgentDirectory = Effect.fn("resolvePiAgentDirectory")(function* (
  settings: Pick<PiSettings, "agentDir">,
  environment?: NodeJS.ProcessEnv,
  cwd: string = process.cwd(),
): Effect.fn.Return<PiAgentDirectory, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configured =
    settings.agentDir.trim() || environment?.PI_CODING_AGENT_DIR?.trim() || "~/.pi/agent";
  const resolvedPath = path.resolve(cwd, expandHomePath(configured));
  const canonicalPath = yield* fileSystem
    .realPath(resolvedPath)
    .pipe(Effect.orElseSucceed(() => resolvedPath));

  return {
    path: canonicalPath,
    continuationKey: `piAgent:agentDir:${canonicalPath}`,
  };
});
