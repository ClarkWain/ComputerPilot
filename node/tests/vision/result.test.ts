import assert from "node:assert/strict";
import test from "node:test";
import { decodeCtc, fuseText, textLinesJson, type TextLine } from "../../src/vision/result.js";

test("CTC collapses adjacent symbols but preserves blank-separated repeats", () => {
  const dictionary = ["", "你", "好", " "];
  const sequence = [1, 1, 0, 1, 2, 2, 3];
  const probabilities = new Float32Array(sequence.length * dictionary.length);
  sequence.forEach((symbol, step) => { probabilities[step * dictionary.length + symbol] = 0.9; });
  const decoded = decodeCtc(probabilities, sequence.length, dictionary);
  assert.equal(decoded.text, "你你好 ");
  assert.ok(decoded.confidence > 0.89 && decoded.confidence < 0.91);
  assert.throws(() => decodeCtc(probabilities, 1, dictionary), /shape mismatch/);
  probabilities[0] = NaN;
  assert.throws(() => decodeCtc(probabilities, sequence.length, dictionary), /finite probabilities/);
});

test("OCR text joins the smallest containing detection; unmatched text stays non-clickable", () => {
  const makeLine = (text: string, x1: number, y1: number, x2: number, y2: number): TextLine => ({
    box: { x1, y1, x2, y2 },
    polygon: [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }],
    text, score: 0.98, detectionScore: 0.88,
  });
  const lines = [makeLine("Create", 30, 30, 100, 55), makeLine("外部文字", 310, 10, 390, 40)];
  const detections = [
    { box: { x1: 0, y1: 0, x2: 300, y2: 300 }, score: 0.9, classId: 0 },
    { box: { x1: 20, y1: 20, x2: 120, y2: 70 }, score: 0.8, classId: 0 },
  ];
  const fused = fuseText(detections, lines, "image-test");
  assert.equal(fused.length, 3);
  assert.equal(fused[0].text, null);
  assert.equal(fused[1].text, "Create");
  assert.deepEqual(fused[1].textRefs, ["t1"]);
  assert.equal(fused[2].text, "外部文字");
  assert.equal(fused[2].point, null);
  assert.equal(fused[2].displayIndex, 3);
  assert.equal(fused[1].nativeRef, null);
  assert.deepEqual(fused[1].nativePatterns, []);
  assert.deepEqual(textLinesJson(lines, "image-test")[0].polygon, [[30, 30], [100, 30], [100, 55], [30, 55]]);
});
