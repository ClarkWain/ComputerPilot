import { performance } from "node:perf_hooks";
import { OcrModels } from "./model.js";
import type { TextLine } from "./result.js";
import { validateRgb, type RgbImage } from "./tensor.js";

export interface OcrOptions {
  maxSide?: number;
  maxLines?: number;
  pixelThreshold?: number;
  boxThreshold?: number;
  textThreshold?: number;
}

export interface OcrResult {
  lines: TextLine[];
  candidateCount: number;
  rejectedCount: number;
  truncated: boolean;
  timingsMs: { detect: number; postprocess: number; recognize: number };
}

interface Candidate { x1: number; y1: number; x2: number; y2: number; score: number }

function option(value: number, min: number, max: number, label: string) {
  if (!Number.isFinite(value) || value < min || value > max) throw new RangeError(`Invalid OCR ${label}`);
  return value;
}

/**
 * Connected-component text extraction. This is a provisional Node equivalent
 * for horizontal UI text; it does not claim OpenCV rotated-contour parity.
 */
export function textCandidates(probability: ArrayLike<number>, width: number, height: number,
                               pixelThreshold = 0.3, boxThreshold = 0.5): Candidate[] {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width * height !== probability.length || width * height > 64_000_000) {
    throw new RangeError("Invalid OCR probability map");
  }
  option(pixelThreshold, 0, 1, "pixelThreshold");
  option(boxThreshold, 0, 1, "boxThreshold");
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    // 2x2 dilation: approximate the native OpenCV mask expansion.
    for (let dy = 0; dy <= 1 && !mask[y * width + x]; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        if (y + dy < height && x + dx < width && probability[(y + dy) * width + x + dx] > pixelThreshold) {
          mask[y * width + x] = 1;
          break;
        }
      }
    }
  }
  const queue = new Int32Array(width * height);
  const candidates: Candidate[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start]) continue;
    let head = 0;
    let tail = 1;
    queue[0] = start;
    mask[start] = 0;
    let x1 = width, y1 = height, x2 = 0, y2 = 0;
    let probabilitySum = 0;
    while (head < tail) {
      const p = queue[head++];
      const x = p % width;
      const y = Math.floor(p / width);
      x1 = Math.min(x1, x); y1 = Math.min(y1, y);
      x2 = Math.max(x2, x); y2 = Math.max(y2, y);
      probabilitySum += probability[p];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const index = ny * width + nx;
        if (mask[index]) { mask[index] = 0; queue[tail++] = index; }
      }
    }
    const rectWidth = x2 - x1 + 1, rectHeight = y2 - y1 + 1;
    if (Math.min(rectWidth, rectHeight) < 3 || tail < 3) continue;
    const score = probabilitySum / tail;
    if (score < boxThreshold) continue;
    const delta = rectWidth * rectHeight * 1.6 / (2 * (rectWidth + rectHeight));
    candidates.push({ x1: x1 - delta, y1: y1 - delta, x2: x2 + delta, y2: y2 + delta, score });
  }
  return candidates.sort((a, b) => b.score - a.score);
}

function crop(image: RgbImage, x1: number, y1: number, x2: number, y2: number): RgbImage {
  const left = Math.max(0, Math.floor(x1));
  const top = Math.max(0, Math.floor(y1));
  const right = Math.min(image.width, Math.ceil(x2));
  const bottom = Math.min(image.height, Math.ceil(y2));
  const width = right - left, height = bottom - top;
  if (width < 1 || height < 1 || width * height > 64_000_000) throw new RangeError("OCR crop exceeds image budget");
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const from = ((top + y) * image.width + left) * 3;
    rgb.set(image.rgb.subarray(from, from + width * 3), y * width * 3);
  }
  return { width, height, rgb };
}

export async function runOcr(models: OcrModels, image: RgbImage, options: OcrOptions = {}): Promise<OcrResult> {
  validateRgb(image);
  const maxSide = option(options.maxSide ?? 960, 32, 2048, "maxSide");
  const maxLines = option(options.maxLines ?? 1000, 1, 10000, "maxLines");
  if (!Number.isInteger(maxSide) || !Number.isInteger(maxLines)) throw new RangeError("Invalid OCR integer option");
  const textThreshold = option(options.textThreshold ?? 0.5, 0, 1, "textThreshold");
  const started = performance.now();
  const probability = await models.detectProbability(image, maxSide);
  const detected = performance.now();
  const candidates = textCandidates(probability.probabilities, probability.width, probability.height,
    options.pixelThreshold, options.boxThreshold);
  const candidateCount = candidates.length;
  let truncated = candidateCount > maxLines;
  candidates.length = Math.min(candidates.length, maxLines);
  const postprocessed = performance.now();
  const lines: TextLine[] = [];
  let rejectedCount = 0;
  const xScale = image.width / probability.width;
  const yScale = image.height / probability.height;
  for (const candidate of candidates) {
    const x1 = Math.max(0, candidate.x1 * xScale);
    const y1 = Math.max(0, candidate.y1 * yScale);
    const x2 = Math.min(image.width - 1, candidate.x2 * xScale);
    const y2 = Math.min(image.height - 1, candidate.y2 * yScale);
    if (x2 - x1 < 4 || y2 - y1 < 4) { rejectedCount++; continue; }
    const region = crop(image, x1, y1, x2, y2);
    if (Math.ceil(48 * region.width / region.height) > 4096) {
      truncated = true; rejectedCount++; continue;
    }
    const decoded = await models.recognizeCrop(region);
    if (!decoded.text || decoded.confidence < textThreshold) { rejectedCount++; continue; }
    lines.push({
      box: { x1, y1, x2, y2 },
      polygon: [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }],
      text: decoded.text, score: decoded.confidence, detectionScore: candidate.score,
    });
  }
  lines.sort((a, b) => a.box.y1 - b.box.y1 || a.box.x1 - b.box.x1);
  return {
    lines, candidateCount, rejectedCount, truncated,
    timingsMs: { detect: detected - started, postprocess: postprocessed - detected, recognize: performance.now() - postprocessed },
  };
}
