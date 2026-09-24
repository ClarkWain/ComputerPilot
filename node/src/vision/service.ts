import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { OnnxDetector } from "./detector.js";
import { loadRgb, OcrModels } from "./model.js";
import { runOcr } from "./ocr.js";
import { fuseText, textLinesJson, type Detection, type TextLine } from "./result.js";

/** Private business operation consumed by Node semantic adapters, never a public MCP tool. */
export class NodeVision {
  private models?: OcrModels;
  private modelDirectory?: string;
  private detector?: OnnxDetector;
  private detectorPath?: string;

  async call(operation: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (operation !== "vision.ocr" && operation !== "vision.parse") throw new Error(`Unknown Node vision operation: ${operation}`);
    if (signal?.aborted) throw new Error("request_cancelled");
    let detectorModel: string | undefined;
    let sourceTorchScript: string | undefined;
    if (operation === "vision.parse") {
      if (typeof args.model !== "string" || !args.model) throw new TypeError("vision.parse requires a model path");
      const model = resolve(args.model);
      if (model.toLowerCase().endsWith(".pt")) {
        sourceTorchScript = model;
        detectorModel = resolve(process.env.DP_OMNIPARSER_ONNX || model.replace(/\.pt$/i, ".onnx"));
        if (!existsSync(detectorModel) || !existsSync(`${detectorModel}.manifest.json`)) {
          return { status: "error", code: "conversion_required", dispatch: "not_started",
            message: "The matching converted OmniParser ONNX and manifest are missing. Run the conversion script during installation." };
        }
      } else if (model.toLowerCase().endsWith(".onnx")) detectorModel = model;
      else throw new TypeError("vision.parse model must be TorchScript .pt or converted .onnx");
    }
    if (typeof args.image !== "string" || !args.image) throw new TypeError("vision requires an image path");
    const [imageBytes, image] = await Promise.all([readFile(args.image), loadRgb(args.image)]);
    const imageRef = `img-sha256-${createHash("sha256").update(imageBytes).digest("hex")}`;
    const result: Record<string, unknown> = {
      status: "ok", imageRef, width: image.width, height: image.height,
      components: { detector: "not_requested", ocr: "not_requested" },
    };
    let detections: Detection[] = [];
    let lines: TextLine[] = [];
    if (operation === "vision.parse") {
      const key = `${detectorModel}\0${sourceTorchScript ?? ""}`;
      if (!this.detector || this.detectorPath !== key) {
        const replacement = await OnnxDetector.load(detectorModel!, sourceTorchScript);
        this.detector = replacement;
        this.detectorPath = key;
      }
      const detected = await this.detector.run(image);
      if (signal?.aborted) throw new Error("request_cancelled");
      detections = detected.detections;
      result.components = { detector: "completed", ocr: "not_requested" };
      result.detectorTimingsMs = detected.timingsMs;
    }
    if (operation === "vision.ocr" || args.ocrModels !== undefined) try {
      if (typeof args.ocrModels !== "string" || !args.ocrModels)
        throw new TypeError("vision OCR requires an ocrModels path");
      const directory = resolve(args.ocrModels);
      if (!this.models || this.modelDirectory !== directory) {
        const replacement = await OcrModels.load(directory);
        this.models = replacement;
        this.modelDirectory = directory;
      }
      if (args.ocrMaxSide !== undefined &&
          (!Number.isInteger(args.ocrMaxSide) || Number(args.ocrMaxSide) < 32 || Number(args.ocrMaxSide) > 2048)) {
        throw new RangeError("ocrMaxSide must be within 32..2048");
      }
      const recognized = await runOcr(this.models, image,
        args.ocrMaxSide === undefined ? {} : { maxSide: Number(args.ocrMaxSide) });
      if (signal?.aborted) throw new Error("request_cancelled");
      lines = recognized.lines;
      result.textLines = textLinesJson(recognized.lines, imageRef);
      result.components = { detector: operation === "vision.parse" ? "completed" : "not_requested",
        ocr: recognized.truncated ? "partial" : "completed" };
      if (recognized.truncated) result.status = "partial";
    } catch (error) {
      result.components = { detector: operation === "vision.parse" ? "completed" : "not_requested", ocr: "failed" };
      result.ocrError = error instanceof Error ? error.message : String(error);
      result.status = "partial";
    }
    result.elements = fuseText(detections, lines, imageRef);
    return result;
  }
}
