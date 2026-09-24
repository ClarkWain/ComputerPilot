import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { preprocessDetector } from "../../src/vision/detector.js";
import { NodeVision } from "../../src/vision/service.js";

const root = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const model = resolve(root, "build/node-vision-validation/omniparser-dynamic.onnx");
const source = resolve(root, "models/icon_detect_v3/model.pt");
const image = resolve(root, "build/release/fixtures/ui.png");
const reference = resolve(root, "build/release/fixtures/result.json");

test("detector letterbox keeps NCHW RGB values and 114 padding", () => {
  const result = preprocessDetector({ width: 1, height: 2, rgb: Uint8Array.of(255, 0, 0, 0, 255, 0) }, 32);
  assert.equal(result.layout.targetWidth, 32);
  assert.equal(result.layout.resizedWidth, 16);
  assert.equal(result.layout.left, 8);
  assert.ok(Math.abs(result.data[0] - 114 / 255) < 1e-7);
  assert.equal(result.data[8], 1);
  assert.equal(result.data[32 * 32 + 8], 0);
});

test("legacy TorchScript path maps to verified ONNX and matches four C++ fixed-image boxes", {
  skip: !existsSync(model) || !existsSync(source) || !existsSync(image) || !existsSync(reference)
    ? "Converted model or generated C++ fixture unavailable" : undefined,
}, async () => {
  const previous = process.env.DP_OMNIPARSER_ONNX;
  process.env.DP_OMNIPARSER_ONNX = model;
  const vision = new NodeVision();
  let result: Record<string, unknown>;
  let partial: Record<string, unknown>;
  try {
    result = await vision.call("vision.parse", { image, model: source });
    partial = await vision.call("vision.parse", { image, model: source,
      ocrModels: resolve(root, "build/node-vision-validation/absent-ocr") });
  }
  finally {
    if (previous === undefined) delete process.env.DP_OMNIPARSER_ONNX;
    else process.env.DP_OMNIPARSER_ONNX = previous;
  }
  assert.equal(result.status, "ok");
  assert.deepEqual(result.components, { detector: "completed", ocr: "not_requested" });
  const actual = result.elements as Array<{ detectorScore: number; classId: number;
    bounds: { x: number; y: number; width: number; height: number } }>;
  const old = JSON.parse(await readFile(reference, "utf8")) as {
    elements: Array<{ detectorScore: number; classId: number;
      bounds: { x: number; y: number; width: number; height: number } }>;
  };
  assert.equal(actual.length, old.elements.length);
  assert.equal(actual.length, 4);
  actual.forEach((detection, index) => {
    const expected = old.elements[index];
    assert.equal(detection.classId, expected.classId);
    assert.ok(Math.abs(detection.detectorScore - expected.detectorScore) < 0.0001);
    assert.ok(Math.abs(detection.bounds.x - expected.bounds.x) < 0.001);
    assert.ok(Math.abs(detection.bounds.y - expected.bounds.y) < 0.001);
    assert.ok(Math.abs(detection.bounds.width - expected.bounds.width) < 0.001);
    assert.ok(Math.abs(detection.bounds.height - expected.bounds.height) < 0.001);
  });
  assert.equal(partial.status, "partial");
  assert.deepEqual(partial.components, { detector: "completed", ocr: "failed" });
  assert.equal((partial.elements as unknown[]).length, 4);
  assert.ok(typeof partial.ocrError === "string");
});
