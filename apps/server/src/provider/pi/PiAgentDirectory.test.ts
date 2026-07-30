import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolvePiAgentDirectory } from "./PiAgentDirectory.ts";

it.layer(NodeServices.layer)("PiAgentDirectory", (it) => {
  const makeTempDir = Effect.fn("PiAgentDirectory.test.makeTempDir")(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-pi-agent-dir-" });
  });

  describe("resolvePiAgentDirectory", () => {
    it.effect("groups configured instances that share an effective directory", () =>
      Effect.gen(function* () {
        const sharedDirectory = yield* makeTempDir();

        const first = yield* resolvePiAgentDirectory({ agentDir: sharedDirectory });
        const second = yield* resolvePiAgentDirectory(
          { agentDir: "" },
          { PI_CODING_AGENT_DIR: sharedDirectory },
        );

        expect(first).toEqual(second);
        expect(first.continuationKey).toBe(`piAgent:agentDir:${first.path}`);
      }),
    );

    it.effect("treats relative and absolute paths to the same directory as equivalent", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* makeTempDir();
        const absoluteDirectory = path.join(root, "agent");
        yield* fileSystem.makeDirectory(absoluteDirectory);

        const relative = yield* resolvePiAgentDirectory({ agentDir: "agent" }, undefined, root);
        const absolute = yield* resolvePiAgentDirectory(
          { agentDir: absoluteDirectory },
          undefined,
          root,
        );

        expect(relative).toEqual(absolute);
      }),
    );

    it.effect("canonicalizes an existing symlink", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* makeTempDir();
        const targetDirectory = path.join(root, "target");
        const linkedDirectory = path.join(root, "linked");
        yield* fileSystem.makeDirectory(targetDirectory);
        yield* fileSystem.symlink(targetDirectory, linkedDirectory);

        const target = yield* resolvePiAgentDirectory({ agentDir: targetDirectory });
        const linked = yield* resolvePiAgentDirectory({ agentDir: linkedDirectory });

        expect(linked).toEqual(target);
      }),
    );

    it.effect("keeps distinct effective directories isolated", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* makeTempDir();
        const firstDirectory = path.join(root, "first");
        const secondDirectory = path.join(root, "second");
        yield* fileSystem.makeDirectory(firstDirectory);
        yield* fileSystem.makeDirectory(secondDirectory);

        const first = yield* resolvePiAgentDirectory({ agentDir: firstDirectory });
        const second = yield* resolvePiAgentDirectory({ agentDir: secondDirectory });

        expect(first.continuationKey).not.toBe(second.continuationKey);
      }),
    );
  });
});
