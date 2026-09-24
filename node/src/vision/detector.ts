import * as ort from "onnxruntime-node";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import type { Box, Detection } from "./result.js";
import { validateRgb, type RgbImage } from "./tensor.js";

export interface DetectorOptions { size?: number; confidence?: number; nmsIou?: number; maxDetections?: number }
export interface Letterbox {
  sourceWidth: number; sourceHeight: number; targetWidth: number; targetHeight: number;
  resizedWidth: number; resizedHeight: number; left: number; top: number; scale: number;
}

function sinc(x: number): number { return Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x); }
function lanczos(x: number): number { return Math.abs(x) >= 3 ? 0 : sinc(x) * sinc(x / 3); }
function filters(source: number, target: number) {
  const result: Array<{ begin: number; weights: number[] }> = [];
  const scale = source / target;
  const supportScale = Math.max(1, scale);
  for (let i = 0; i < target; i++) {
    const center = (i + 0.5) * scale;
    const begin = Math.max(0, Math.floor(center - 3 * supportScale + 0.5));
    const end = Math.min(source, Math.floor(center + 3 * supportScale + 0.5));
    const weights: number[] = [];
    let sum = 0;
    for (let k = begin; k < end; k++) { const weight = lanczos((k + 0.5 - center) / supportScale); weights.push(weight); sum += weight; }
    if (Math.abs(sum) < 1e-12) throw new Error("Degenerate resize filter");
    result.push({ begin, weights: weights.map(weight => weight / sum) });
  }
  return result;
}
function quantize(value: number): number { return Math.max(0, Math.min(255, Math.floor(value + 0.5))); }

/** Port of src/core.cpp's two-pass, per-pass 8-bit Lanczos3 detector preprocessing. */
export function preprocessDetector(image: RgbImage, size = 640): { data: Float32Array; layout: Letterbox } {
  validateRgb(image);
  if (!Number.isInteger(size) || size < 32 || size > 2048) throw new RangeError("detector size must be 32..2048");
  const target = Math.ceil(size / 32) * 32;
  const scale = Math.min(target / image.width, target / image.height);
  const resizedWidth = Math.max(1, Math.trunc(image.width * scale));
  const resizedHeight = Math.max(1, Math.trunc(image.height * scale));
  const layout = {
    sourceWidth: image.width, sourceHeight: image.height, targetWidth: target, targetHeight: target,
    resizedWidth, resizedHeight, left: Math.trunc((target - resizedWidth) / 2),
    top: Math.trunc((target - resizedHeight) / 2), scale,
  };
  const xFilters = filters(image.width, resizedWidth);
  const yFilters = filters(image.height, resizedHeight);
  const intermediate = new Uint8Array(resizedWidth * image.height * 3);
  for (let y = 0; y < image.height; y++) for (let x = 0; x < resizedWidth; x++) {
    const filter = xFilters[x];
    for (let c = 0; c < 3; c++) {
      let value = 0;
      for (let k = 0; k < filter.weights.length; k++)
        value += image.rgb[(y * image.width + filter.begin + k) * 3 + c] * filter.weights[k];
      intermediate[(y * resizedWidth + x) * 3 + c] = quantize(value);
    }
  }
  const plane = target * target;
  const data = new Float32Array(plane * 3).fill(114 / 255);
  for (let y = 0; y < resizedHeight; y++) for (let x = 0; x < resizedWidth; x++) {
    const filter = yFilters[y];
    for (let c = 0; c < 3; c++) {
      let value = 0;
      for (let k = 0; k < filter.weights.length; k++)
        value += intermediate[((filter.begin + k) * resizedWidth + x) * 3 + c] * filter.weights[k];
      data[c * plane + (y + layout.top) * target + x + layout.left] = quantize(value) / 255;
    }
  }
  return { data, layout };
}

function area(box: Box) { return Math.max(0, box.x2 - box.x1) * Math.max(0, box.y2 - box.y1); }
function iou(a: Box, b: Box) {
  const intersection = area({
    x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
    x2: Math.min(a.x2, b.x2), y2: Math.min(a.y2, b.y2),
  });
  const union = area(a) + area(b) - intersection;
  return union > 0 ? intersection / union : 0;
}
function validateOptions(options: DetectorOptions) {
  const confidence = options.confidence ?? 0.25;
  const nmsIou = options.nmsIou ?? 0.7;
  const maxDetections = options.maxDetections ?? 300;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1 ||
      !Number.isFinite(nmsIou) || nmsIou < 0 || nmsIou > 1 ||
      !Number.isInteger(maxDetections) || maxDetections < 1 || maxDetections > 10000)
    throw new RangeError("Invalid detector settings");
  return { confidence, nmsIou, maxDetections };
}

/** Port of src/detector_torch.cpp's raw six-head decode and src/core.cpp NMS. */
export function decodeDetectorHeads(heads: readonly ort.Tensor[], layout: Letterbox,
                                    options: DetectorOptions = {}): Detection[] {
  const opt = validateOptions(options);
  if (heads.length !== 6) throw new Error("Unsupported detector contract: expected exactly three logits/distance pairs");
  const candidates: Detection[] = [];
  for (let i = 0; i < 3; i++) {
    const logits = heads[2 * i], distance = heads[2 * i + 1];
    const stride = 8 * 2 ** i;
    if (logits.type !== "float32" || distance.type !== "float32" || logits.dims.length !== 4 ||
        distance.dims.length !== 4 || logits.dims[0] !== 1 || distance.dims[0] !== 1 ||
        logits.dims[1] < 1 || distance.dims[1] !== 4 ||
        logits.dims[2] !== distance.dims[2] || logits.dims[3] !== distance.dims[3] ||
        logits.dims[2] !== layout.targetHeight / stride || logits.dims[3] !== layout.targetWidth / stride) {
      throw new Error("Detector head shape does not match YOLOv9 raw-head contract");
    }
    const height = logits.dims[2], width = logits.dims[3], classes = logits.dims[1];
    const plane = height * width;
    const scores = logits.data as Float32Array, distances = distance.data as Float32Array;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const p = y * width + x;
      let classId = 0, best = scores[p];
      for (let c = 1; c < classes; c++) if (scores[c * plane + p] > best) { best = scores[c * plane + p]; classId = c; }
      const score = 1 / (1 + Math.exp(-best));
      if (!(score > opt.confidence)) continue;
      const anchorX = (x + 0.5) * stride, anchorY = (y + 0.5) * stride;
      const box = {
        x1: (anchorX - distances[p] * stride - layout.left) / layout.scale,
        y1: (anchorY - distances[plane + p] * stride - layout.top) / layout.scale,
        x2: (anchorX + distances[2 * plane + p] * stride - layout.left) / layout.scale,
        y2: (anchorY + distances[3 * plane + p] * stride - layout.top) / layout.scale,
      };
      candidates.push({ box, score, classId });
    }
  }
  const sorted = candidates.filter(item => Number.isFinite(item.score) &&
    Object.values(item.box).every(Number.isFinite) && area(item.box) > 0).sort((a, b) => b.score - a.score);
  const selected: Detection[] = [];
  for (const item of sorted) {
    if (selected.length >= opt.maxDetections) break;
    if (selected.some(other => other.classId === item.classId && iou(other.box, item.box) > opt.nmsIou)) continue;
    const box = {
      x1: Math.max(0, Math.min(layout.sourceWidth, item.box.x1)),
      y1: Math.max(0, Math.min(layout.sourceHeight, item.box.y1)),
      x2: Math.max(0, Math.min(layout.sourceWidth, item.box.x2)),
      y2: Math.max(0, Math.min(layout.sourceHeight, item.box.y2)),
    };
    if (box.x2 > box.x1 && box.y2 > box.y1) selected.push({ ...item, box });
  }
  return selected;
}

export class OnnxDetector {
  private constructor(private readonly session: ort.InferenceSession) {}
  static async load(path: string, sourceTorchScript?: string) {
    if (!path.toLowerCase().endsWith(".onnx")) throw new Error("OmniParser Node detector requires a converted ONNX model");
    const manifest = JSON.parse(await readFile(`${path}.manifest.json`, "utf8")) as Record<string, unknown>;
    if (manifest.schemaVersion !== 1 ||
        manifest.sourceSha256 !== "11c6cbb77f22569fab22d86c76407a83ec81ab89dbfe28279854822d6e3fb00c" ||
        manifest.contract !== "yolov9_raw_logits_distances_3_scales" || manifest.opset !== 17 ||
        typeof manifest.onnxSha256 !== "string" || !/^[0-9a-f]{64}$/.test(manifest.onnxSha256)) {
      throw new Error("Unsupported OmniParser ONNX provenance manifest");
    }
    const fileSha = async (name: string) => {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(name)) hash.update(chunk);
      return hash.digest("hex");
    };
    if (manifest.onnxBytes !== (await stat(path)).size ||
        (await fileSha(path)) !== manifest.onnxSha256) {
      throw new Error("OmniParser ONNX artifact does not match its provenance manifest");
    }
    if (sourceTorchScript && (await fileSha(sourceTorchScript)) !== manifest.sourceSha256)
      throw new Error("OmniParser source TorchScript does not match converted ONNX provenance");
    const session = await ort.InferenceSession.create(path, {
      executionProviders: ["cpu"], intraOpNumThreads: 4, interOpNumThreads: 1, graphOptimizationLevel: "all",
    });
    if (session.inputNames.length !== 1 || session.outputNames.length !== 6)
      throw new Error("Unsupported OmniParser ONNX input/output contract");
    return new OnnxDetector(session);
  }
  async run(image: RgbImage, options: DetectorOptions = {}) {
    const start = performance.now();
    const { data, layout } = preprocessDetector(image, options.size ?? 640);
    const prepared = performance.now();
    const output = await this.session.run({
      [this.session.inputNames[0]]: new ort.Tensor("float32", data, [1, 3, layout.targetHeight, layout.targetWidth]),
    });
    const forwarded = performance.now();
    const detections = decodeDetectorHeads(this.session.outputNames.map(name => output[name]), layout, options);
    return { detections, tensorShapes: this.session.outputNames.map(name => output[name].dims),
      timingsMs: { preprocess: prepared - start, forward: forwarded - prepared, postprocess: performance.now() - forwarded } };
  }
}
