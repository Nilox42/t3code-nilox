// @effect-diagnostics nodeBuiltinImport:off - Tests compare generated binary assets directly.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { PNG } from "pngjs";
import { describe, expect, it } from "vite-plus/test";

import { generateNiloxIconOutputs, NILOX_ICON_OUTPUT_PATHS } from "./export-nilox-icons.ts";
import { readPngDimensions, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");

function icoSizes(contents: Buffer): number[] {
  const count = contents.readUInt16LE(4);
  return Array.from({ length: count }, (_, index) => {
    const encoded = contents.readUInt8(6 + index * 16);
    return encoded === 0 ? 256 : encoded;
  });
}

describe("Nilox icons", () => {
  it("has fresh generated files at every required dimension", async () => {
    const generated = await generateNiloxIconOutputs();
    for (const [key, relativePath] of Object.entries(NILOX_ICON_OUTPUT_PATHS)) {
      expect(await NodeFSP.readFile(NodePath.join(repoRoot, relativePath))).toEqual(generated[key]);
    }

    expect(readPngDimensions(generated.universal!)).toEqual({ width: 1024, height: 1024 });
    expect(readPngDimensions(generated.mac!)).toEqual({ width: 1024, height: 1024 });
    expect(readPngDimensions(generated.appleTouch!)).toEqual({ width: 180, height: 180 });
    expect(readPngDimensions(generated.favicon32!)).toEqual({ width: 32, height: 32 });
    expect(readPngDimensions(generated.favicon16!)).toEqual({ width: 16, height: 16 });
    expect(icoSizes(generated.windows!)).toEqual([...WINDOWS_ICON_SIZES]);
    expect(icoSizes(generated.faviconIco!)).toEqual([16, 32]);
  });

  it("keeps transparent macOS corners and a violet lower-right badge", async () => {
    const generated = await generateNiloxIconOutputs();
    const mac = PNG.sync.read(generated.mac!);
    const universal = PNG.sync.read(generated.universal!);
    expect(mac.data[3]).toBe(0);

    const badgePixelOffset = (800 * universal.width + 800) * 4;
    expect([...universal.data.subarray(badgePixelOffset, badgePixelOffset + 4)]).toEqual([
      124, 58, 237, 255,
    ]);
  });
});
