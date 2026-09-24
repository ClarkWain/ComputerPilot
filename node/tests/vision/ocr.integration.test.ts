import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { NodeVision } from "../../src/vision/service.js";

const root = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const image = resolve(root, "build/release/fixtures/ui.png");
const ocrModels = resolve(root, "models/ocr");

test("Node ONNX OCR recognizes English and Chinese on the existing fixed image", {
  skip: !existsSync(image) || !existsSync(resolve(ocrModels, "det.onnx")) ||
    !existsSync(resolve(ocrModels, "rec.onnx")) ? "OCR models or generated fixture unavailable" : undefined,
}, async () => {
  const vision = new NodeVision();
  const result = await vision.call("vision.ocr", { image, ocrModels });
  assert.equal(result.status, "ok", String(result.ocrError ?? ""));
  assert.deepEqual(result.components, { detector: "not_requested", ocr: "completed" });
  assert.equal(result.width, 960);
  assert.equal(result.height, 640);
  const lines = result.textLines as Array<{ text: string; bounds: { x: number; y: number; width: number; height: number } }>;
  assert.equal(lines.length, 11);
  assert.ok(lines.some(line => line.text === "Create"));
  assert.ok(lines.some(line => line.text === "Cancel"));
  assert.ok(lines.some(line => line.text.includes("车窗")));
  assert.ok(lines.every(line => line.bounds.x >= 0 && line.bounds.y >= 0 &&
    line.bounds.width > 0 && line.bounds.height > 0 &&
    line.bounds.x + line.bounds.width <= 960 && line.bounds.y + line.bounds.height <= 640));
  assert.equal((result.elements as Array<unknown>).length, lines.length);
});

test("legacy TorchScript request reports conversion_required when companion artifact is missing", async () => {
  const previous = process.env.DP_OMNIPARSER_ONNX;
  delete process.env.DP_OMNIPARSER_ONNX;
  let result: Record<string, unknown>;
  try { result = await new NodeVision().call("vision.parse", { model: resolve(root, "models/icon_detect_v3/model.pt") }); }
  finally { if (previous !== undefined) process.env.DP_OMNIPARSER_ONNX = previous; }
  assert.equal(result.code, "conversion_required");
  assert.equal(result.dispatch, "not_started");
});
