/** Image tensor preparation for the PP-OCRv4 ONNX models. RGB bytes are interleaved. */
export interface RgbImage { width: number; height: number; rgb: Uint8Array }

export function validateRgb(image: RgbImage) {
  if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) ||
      image.width < 1 || image.height < 1 || image.width * image.height > 64_000_000 ||
      image.rgb.length !== image.width * image.height * 3) {
    throw new RangeError("Invalid RGB image dimensions/buffer (limit: 64 million pixels)");
  }
}

/** OpenCV INTER_LINEAR-like half-pixel mapping, BGR NCHW, (value / 127.5) - 1. */
export function ocrTensor(image: RgbImage, width: number, height: number, paddedWidth = width): Float32Array {
  validateRgb(image);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || !Number.isSafeInteger(paddedWidth) ||
      width < 1 || height < 1 || paddedWidth < width || paddedWidth > 4096 || height > 2048) {
    throw new RangeError("Invalid OCR tensor dimensions");
  }
  const plane = paddedWidth * height;
  const tensor = new Float32Array(plane * 3);
  for (let y = 0; y < height; y++) {
    const sourceY = Math.max(0, (y + 0.5) * image.height / height - 0.5);
    const y0 = Math.min(image.height - 1, Math.floor(sourceY));
    const y1 = Math.min(image.height - 1, y0 + 1);
    const wy = sourceY - y0;
    for (let x = 0; x < width; x++) {
      const sourceX = Math.max(0, (x + 0.5) * image.width / width - 0.5);
      const x0 = Math.min(image.width - 1, Math.floor(sourceX));
      const x1 = Math.min(image.width - 1, x0 + 1);
      const wx = sourceX - x0;
      for (let channel = 0; channel < 3; channel++) {
        const rgbChannel = 2 - channel;
        const top = image.rgb[(y0 * image.width + x0) * 3 + rgbChannel] * (1 - wx) +
                    image.rgb[(y0 * image.width + x1) * 3 + rgbChannel] * wx;
        const bottom = image.rgb[(y1 * image.width + x0) * 3 + rgbChannel] * (1 - wx) +
                       image.rgb[(y1 * image.width + x1) * 3 + rgbChannel] * wx;
        tensor[channel * plane + y * paddedWidth + x] = Math.round(top * (1 - wy) + bottom * wy) / 127.5 - 1;
      }
    }
  }
  return tensor;
}

export function detectionSize(image: Pick<RgbImage, "width" | "height">, maxSide: number) {
  if (!Number.isInteger(maxSide) || maxSide < 32 || maxSide > 2048) {
    throw new RangeError("ocrMaxSide must be within 32..2048");
  }
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  return {
    width: Math.max(32, Math.round(Math.trunc(image.width * scale) / 32) * 32),
    height: Math.max(32, Math.round(Math.trunc(image.height * scale) / 32) * 32),
  };
}
