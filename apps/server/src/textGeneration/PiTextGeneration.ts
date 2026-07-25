import type { ModelSelection, PiSettings } from "@t3tools/contracts";
import { TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  clampPiThinkingLevel,
  makePiRpcSessionRuntime,
  parsePiModelSlug,
} from "../provider/pi/PiRpcSessionRuntime.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const PI_TEXT_GENERATION_TIMEOUT_MS = 180_000;
const isTextGenerationError = Schema.is(TextGenerationError);
type Operation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

export const makePiTextGeneration = Effect.fn("makePiTextGeneration")((
  settings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
  timeoutMs: number = PI_TEXT_GENERATION_TIMEOUT_MS,
) => {
  const runPiJson = <S extends Schema.Top>(input: {
    readonly operation: Operation;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchema: S;
    readonly modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const parsedModel = parsePiModelSlug(input.modelSelection.model);
      if (!parsedModel) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: `Invalid Pi model slug '${input.modelSelection.model}'.`,
        });
      }
      const runtime = yield* makePiRpcSessionRuntime({
        binaryPath: settings.binaryPath || "pi",
        cwd: input.cwd,
        environment,
        agentDir: settings.agentDir,
        launchArgs: settings.launchArgs,
        trustProjectResources: false,
        noSession: true,
        noTools: true,
        disableResources: true,
        requestTimeoutMs: timeoutMs,
      });
      const state = yield* runtime.getState();
      const selectedModel = yield* runtime.setModel(parsedModel.provider, parsedModel.modelId);
      yield* runtime.setThinkingLevel(
        clampPiThinkingLevel(
          getModelSelectionStringOptionValue(input.modelSelection, "thinkingLevel"),
          selectedModel,
          state.thinkingLevel,
        ),
      );
      yield* runtime.prompt({ message: input.prompt });
      yield* runtime.waitForSettled(timeoutMs);
      const output = (yield* runtime.getLastAssistantText())?.trim();
      if (!output) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: "Pi Agent returned empty output.",
        });
      }
      // oxlint-disable-next-line t3code/no-inline-schema-compile -- The generated output schema is operation-specific and supplied by the prompt builder.
      return yield* Schema.decodeEffect(Schema.fromJsonString(input.outputSchema))(
        extractJsonObject(output),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: "Pi Agent returned invalid structured output.",
              cause,
            }),
        ),
      );
    }).pipe(
      Effect.scoped,
      Effect.timeoutOption(timeoutMs),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({
                operation: input.operation,
                detail: "Pi Agent text generation timed out.",
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation: input.operation,
              detail: "Pi Agent text generation failed.",
              cause,
            }),
      ),
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("PiTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
      });
      const generated = yield* runPiJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("PiTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt(input);
      const generated = yield* runPiJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("PiTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt(input);
      const generated = yield* runPiJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("PiTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt(input);
      const generated = yield* runPiJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizeThreadTitle(generated.title) };
    });

  return Effect.succeed({
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"]);
});
