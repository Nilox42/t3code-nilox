#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Deterministic host-side asset generator.

import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import sharp from "sharp";

import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

export const NILOX_ICON_OUTPUT_PATHS = {
  universal: BRAND_ASSET_PATHS.niloxLinuxIconPng,
  mac: BRAND_ASSET_PATHS.niloxMacIconPng,
  windows: BRAND_ASSET_PATHS.niloxWindowsIconIco,
  appleTouch: BRAND_ASSET_PATHS.niloxWebAppleTouchIconPng,
  favicon16: BRAND_ASSET_PATHS.niloxWebFavicon16Png,
  favicon32: BRAND_ASSET_PATHS.niloxWebFavicon32Png,
  faviconIco: BRAND_ASSET_PATHS.niloxWebFaviconIco,
} as const;

async function renderPng(svg: Buffer, size: number): Promise<Buffer> {
  return sharp(svg, { density: 384 })
    .resize(size, size, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
}

export async function generateNiloxIconOutputs(): Promise<Readonly<Record<string, Buffer>>> {
  const svg = await NodeFSP.readFile(NodePath.join(repoRoot, BRAND_ASSET_PATHS.niloxSvgSource));
  const universal = await renderPng(svg, 1024);
  const macBody = await sharp(universal).resize(824, 824).png().toBuffer();
  const mac = await sharp({
    create: { width: 1024, height: 1024, channels: 4, background: "#00000000" },
  })
    .composite([{ input: macBody, left: 100, top: 100 }])
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
  const renditions = await Promise.all(
    WINDOWS_ICON_SIZES.map(async (size) => ({ size, contents: await renderPng(svg, size) })),
  );
  const faviconRenditions = renditions.filter(({ size }) => size === 16 || size === 32);

  return {
    universal,
    mac,
    windows: encodePngIco(renditions),
    appleTouch: await renderPng(svg, 180),
    favicon16: faviconRenditions.find(({ size }) => size === 16)!.contents,
    favicon32: faviconRenditions.find(({ size }) => size === 32)!.contents,
    faviconIco: encodePngIco(faviconRenditions),
  };
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const outputs = await generateNiloxIconOutputs();
  const stale: string[] = [];

  for (const [key, relativePath] of Object.entries(NILOX_ICON_OUTPUT_PATHS)) {
    const expected = outputs[key]!;
    const absolutePath = NodePath.join(repoRoot, relativePath);
    if (check) {
      const actual = await NodeFSP.readFile(absolutePath).catch(() => null);
      if (actual === null || !actual.equals(expected)) stale.push(relativePath);
    } else {
      await NodeFSP.writeFile(absolutePath, expected);
    }
  }

  if (stale.length > 0) {
    throw new Error(
      `Generated Nilox icon assets are stale:\n${stale.map((entry) => `- ${entry}`).join("\n")}`,
    );
  }

  console.log(check ? "Nilox icon assets are fresh." : "Generated Nilox icon assets.");
}

if (import.meta.main) await main();
