/** Result shaping shared by the optional Node visual backends. Coordinates are image pixels. */
export interface Box { x1: number; y1: number; x2: number; y2: number }
export interface Point { x: number; y: number }
export interface Detection { box: Box; score: number; classId: number }
export interface TextLine {
  box: Box;
  polygon: [Point, Point, Point, Point];
  text: string;
  score: number;
  detectionScore: number;
}

function bounds(box: Box) {
  return { space: "image_px", x: box.x1, y: box.y1, width: box.x2 - box.x1, height: box.y2 - box.y1 };
}

export function decodeCtc(data: ArrayLike<number>, steps: number, dictionary: readonly string[]) {
  if (!Number.isSafeInteger(steps) || steps < 0 || dictionary.length < 2 ||
      steps * dictionary.length !== data.length) {
    throw new RangeError("CTC tensor/dictionary shape mismatch");
  }
  let previous = 0;
  let count = 0;
  let confidence = 0;
  let text = "";
  for (let t = 0; t < steps; t++) {
    const offset = t * dictionary.length;
    let current = 0;
    let best = -Infinity;
    for (let c = 0; c < dictionary.length; c++) {
      const probability = data[offset + c];
      if (!Number.isFinite(probability) || probability < 0 || probability > 1.001) {
        throw new Error("CTC model must return finite probabilities, not logits");
      }
      if (probability > best) { best = probability; current = c; }
    }
    if (current !== 0 && current !== previous) {
      text += dictionary[current];
      confidence += best;
      count++;
    }
    previous = current;
  }
  return { text, confidence: count ? confidence / count : 0 };
}

export function textLinesJson(lines: readonly TextLine[], imageRef: string) {
  return lines.map((line, index) => ({
    textRef: `t${index + 1}`, imageRef, text: line.text, bounds: bounds(line.box),
    polygon: line.polygon.map(point => [point.x, point.y]), coordinateSpace: "image_px",
    recognitionScore: line.score, detectionScore: line.detectionScore, source: "ocr.ppocr_v4",
  }));
}

function area(box: Box) { return Math.max(0, box.x2 - box.x1) * Math.max(0, box.y2 - box.y1); }

/** Mirrors the existing C++ smallest-containing-region rule and preserves unmatched OCR. */
export function fuseText(detections: readonly Detection[], lines: readonly TextLine[], imageRef: string) {
  const elements: Record<string, unknown>[] = detections.map((detection, index) => {
    const { box } = detection;
    return {
      nodeRef: `${imageRef}:r${index + 1}`, nativeRef: null,
      visualRef: { imageRef, regionId: `r${index + 1}` }, bounds: bounds(box),
      point: { space: "image_px", x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2, kind: "candidate" },
      classId: detection.classId, detectorScore: detection.score, text: null,
      evidence: { region: "omniparser.icon_detect_v3" }, nativePatterns: [],
      state: { enabled: "unknown", occluded: "unknown" },
    };
  });
  const members = detections.map(() => [] as number[]);
  const unmatched: number[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    let selected = -1;
    let smallest = Infinity;
    for (let d = 0; d < detections.length; d++) {
      const box = detections[d].box;
      const intersection = {
        x1: Math.max(box.x1, line.box.x1), y1: Math.max(box.y1, line.box.y1),
        x2: Math.min(box.x2, line.box.x2), y2: Math.min(box.y2, line.box.y2),
      };
      const coverage = area(line.box) > 0 ? area(intersection) / area(line.box) : 0;
      const cx = (line.box.x1 + line.box.x2) / 2;
      const cy = (line.box.y1 + line.box.y2) / 2;
      if (coverage >= 0.7 && cx >= box.x1 && cx <= box.x2 && cy >= box.y1 && cy <= box.y2 &&
          area(box) < smallest) {
        selected = d;
        smallest = area(box);
      }
    }
    if (selected >= 0) members[selected].push(index);
    else unmatched.push(index);
  }
  for (let d = 0; d < detections.length; d++) {
    const group = members[d];
    group.sort((a, b) => lines[a].box.y1 - lines[b].box.y1 || lines[a].box.x1 - lines[b].box.x1);
    elements[d].kind = "detected_region";
    elements[d].textRefs = group.map(index => `t${index + 1}`);
    if (group.length) {
      elements[d].text = group.map(index => lines[index].text).join("\n");
      elements[d].evidence = { region: "omniparser.icon_detect_v3", text: "ocr.ppocr_v4" };
    }
  }
  for (const index of unmatched) {
    const ref = `t${index + 1}`;
    const line = lines[index];
    elements.push({
      nodeRef: `${imageRef}:${ref}`, nativeRef: null, kind: "text",
      visualRef: { imageRef, regionId: ref }, bounds: bounds(line.box), point: null,
      text: line.text, textRefs: [ref],
      evidence: { region: "ocr.ppocr_v4", text: "ocr.ppocr_v4" },
      nativePatterns: [], state: { enabled: "unknown", occluded: "unknown" },
    });
  }
  elements.forEach((element, index) => { element.displayIndex = index + 1; });
  return elements;
}
