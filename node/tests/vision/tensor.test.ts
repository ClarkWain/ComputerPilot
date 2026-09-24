import assert from "node:assert/strict";
import test from "node:test";
import { detectionSize, ocrTensor } from "../../src/vision/tensor.js";

test("OCR tensor is BGR, normalized, NCHW and zero-padded only at recognition width", () => {
  const image = { width: 1, height: 1, rgb: Uint8Array.of(255, 127, 0) };
  const tensor = ocrTensor(image, 1, 1, 2);
  assert.equal(tensor.length, 6);
  assert.equal(tensor[0], -1);
  assert.equal(tensor[1], 0);
  assert.ok(Math.abs(tensor[2] - (127 / 127.5 - 1)) < 1e-7);
  assert.equal(tensor[3], 0);
  assert.equal(tensor[4], 1);
  assert.equal(tensor[5], 0);
});

test("OCR detection geometry rounds to multiples of 32 with a 32 pixel floor", () => {
  assert.deepEqual(detectionSize({ width: 960, height: 640 }, 960), { width: 960, height: 640 });
  assert.deepEqual(detectionSize({ width: 1920, height: 1080 }, 960), { width: 960, height: 544 });
  assert.deepEqual(detectionSize({ width: 10, height: 10 }, 960), { width: 32, height: 32 });
  assert.throws(() => detectionSize({ width: 10, height: 10 }, 4096), /ocrMaxSide/);
});
