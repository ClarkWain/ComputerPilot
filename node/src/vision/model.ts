import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as ort from "onnxruntime-node";
import sharp from "sharp";
import { detectionSize, ocrTensor, type RgbImage } from "./tensor.js";
import { decodeCtc } from "./result.js";

const DET_SHA = "d2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9";
const REC_SHA = "48fc40f24f6d2a207a2b1091d3437eb3cc3eb6b676dc3ef9c37384005483683b";

function varint(bytes: Uint8Array, cursor: { offset: number }, end: number): number {
  let result = 0;
  let shift = 0;
  for (let count = 0; count < 10 && cursor.offset < end; count++) {
    const byte = bytes[cursor.offset++];
    result += (byte & 127) * 2 ** shift;
    if (!Number.isSafeInteger(result)) throw new Error("ONNX protobuf field exceeds safe integer range");
    if (!(byte & 128)) return result;
    shift += 7;
  }
  throw new Error("Malformed ONNX protobuf varint");
}

function nextField(bytes: Uint8Array, cursor: { offset: number }, end: number) {
  const tag = varint(bytes, cursor, end);
  const field = Math.floor(tag / 8);
  const wire = tag % 8;
  if (field < 1) throw new Error("Malformed ONNX protobuf field number");
  if (wire === 0) { varint(bytes, cursor, end); return { field, start: cursor.offset, end: cursor.offset }; }
  if (wire === 1 || wire === 5) {
    const start = cursor.offset;
    cursor.offset += wire === 1 ? 8 : 4;
    if (cursor.offset > end) throw new Error("Truncated ONNX protobuf field");
    return { field, start, end: cursor.offset };
  }
  if (wire !== 2) throw new Error("Unsupported ONNX protobuf wire type");
  const size = varint(bytes, cursor, end);
  const start = cursor.offset;
  cursor.offset += size;
  if (cursor.offset > end) throw new Error("Truncated ONNX protobuf field");
  return { field, start, end: cursor.offset };
}

/** ONNX ModelProto.metadata_props (field 14), StringStringEntryProto key/value. */
export function modelMetadata(bytes: Uint8Array): Map<string, string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const metadata = new Map<string, string>();
  const cursor = { offset: 0 };
  while (cursor.offset < bytes.length) {
    const entry = nextField(bytes, cursor, bytes.length);
    if (entry.field !== 14) continue;
    const nested = { offset: entry.start };
    let key: string | undefined;
    let value: string | undefined;
    while (nested.offset < entry.end) {
      const part = nextField(bytes, nested, entry.end);
      if (part.field === 1) key = decoder.decode(bytes.subarray(part.start, part.end));
      if (part.field === 2) value = decoder.decode(bytes.subarray(part.start, part.end));
    }
    if (key !== undefined && value !== undefined) metadata.set(key, value);
  }
  return metadata;
}

export async function loadRgb(path: string): Promise<RgbImage> {
  const { data, info } = await sharp(path).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  const image = { width: info.width, height: info.height, rgb: data };
  if (info.channels !== 3 || info.width * info.height > 64_000_000) {
    throw new RangeError("Invalid RGB image dimensions/buffer (limit: 64 million pixels)");
  }
  return image;
}

function sha256(bytes: Uint8Array) { return createHash("sha256").update(bytes).digest("hex"); }

export class OcrModels {
  private constructor(
    readonly detector: ort.InferenceSession,
    readonly recognizer: ort.InferenceSession,
    readonly dictionary: readonly string[],
  ) {}

  static async load(directory: string): Promise<OcrModels> {
    const detPath = join(directory, "det.onnx");
    const recPath = join(directory, "rec.onnx");
    const [detBytes, recBytes] = await Promise.all([readFile(detPath), readFile(recPath)]);
    if (sha256(detBytes) !== DET_SHA || sha256(recBytes) !== REC_SHA) {
      throw new Error("OCR weights do not match the supported PP-OCRv4 model contract");
    }
    const characters = modelMetadata(recBytes).get("character");
    if (!characters) throw new Error("Missing embedded OCR character dictionary");
    const lines = characters.replace(/\r/g, "").split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (lines.some(line => !line)) throw new Error("Empty OCR dictionary entry");
    const dictionary = ["", ...lines, " "];
    const options: ort.InferenceSession.SessionOptions = {
      executionProviders: ["cpu"], intraOpNumThreads: 4, interOpNumThreads: 1,
      graphOptimizationLevel: "all",
    };
    const [detector, recognizer] = await Promise.all([
      ort.InferenceSession.create(detPath, options),
      ort.InferenceSession.create(recPath, options),
    ]);
    if (detector.inputNames.length !== 1 || detector.outputNames.length !== 1 ||
        recognizer.inputNames.length !== 1 || recognizer.outputNames.length !== 1 ||
        dictionary.length !== 6625) {
      throw new Error("Unsupported PP-OCRv4 model input/output or dictionary contract");
    }
    return new OcrModels(detector, recognizer, dictionary);
  }

  /** Real ONNX detector inference. Postprocessing into text lines is a separate migration gate. */
  async detectProbability(image: RgbImage, maxSide = 960) {
    const { width, height } = detectionSize(image, maxSide);
    const data = ocrTensor(image, width, height);
    const output = await this.detector.run({
      [this.detector.inputNames[0]]: new ort.Tensor("float32", data, [1, 3, height, width]),
    });
    const tensor = output[this.detector.outputNames[0]];
    if (!tensor || tensor.type !== "float32" ||
        tensor.dims.join(",") !== `1,1,${height},${width}`) {
      throw new Error("Unsupported OCR detection output geometry");
    }
    const probabilities = tensor.data as Float32Array;
    if (probabilities.some(value => !Number.isFinite(value) || value < 0 || value > 1.001)) {
      throw new Error("Invalid text detection probabilities");
    }
    return { width, height, probabilities };
  }

  /** Recognize an already segmented RGB text crop; caller owns box extraction. */
  async recognizeCrop(crop: RgbImage) {
    const contentWidth = Math.ceil(48 * crop.width / crop.height);
    if (contentWidth > 4096) throw new RangeError("OCR crop exceeds recognition width budget");
    const width = Math.max(320, contentWidth);
    const data = ocrTensor(crop, contentWidth, 48, width);
    const output = await this.recognizer.run({
      [this.recognizer.inputNames[0]]: new ort.Tensor("float32", data, [1, 3, 48, width]),
    });
    const tensor = output[this.recognizer.outputNames[0]];
    if (!tensor || tensor.type !== "float32" || tensor.dims.length !== 3 ||
        tensor.dims[0] !== 1 || tensor.dims[1] < 1 || tensor.dims[2] !== this.dictionary.length) {
      throw new Error("Unexpected OCR CTC output");
    }
    return decodeCtc(tensor.data as Float32Array, tensor.dims[1], this.dictionary);
  }
}
