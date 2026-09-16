# Third-party notices

## libwebp 1.6.0

Copyright (c) 2010 Google Inc. and The WebM Project authors.
Source: https://chromium.googlesource.com/webm/libwebp/+/refs/tags/v1.6.0
BSD license and additional patent grant: upstream COPYING and PATENTS are copied
to build/licenses/webp and included in release packages. The C codec is linked
statically for WebP screenshots; no model or Python runtime is involved.
Official archive SHA-256:
e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564.

## Microsoft OmniParser

The YOLOv9 adapter contract in `src/detector_torch.cpp` is adapted from Microsoft
OmniParser `util/yolov9.py`: https://github.com/microsoft/OmniParser.
Changes: independent C++ preprocessing, CPU LibTorch execution, native output
decoding/NMS, input validation, provenance and structured output.
Upstream repository code is licensed under CC-BY-4.0:
https://creativecommons.org/licenses/by/4.0/ .
This attribution does not imply endorsement by Microsoft.

Model candidate: `microsoft/OmniParser-v2.0`, revision
`ef77ffa0da68a824fd59a2d11215e2862b07b5e9`, `icon_detect_v3/model.pt`.
The upstream README describes the new YOLOv9 detector as MIT, distinct from the
older AGPL Ultralytics detector. The selected PR tree does not include a separate
license file beside this weight. Keep this distinction visible; obtain the exact
model license notice before redistributing a bundled model package.

## nlohmann/json 3.12.0

Copyright (c) 2013-2025 Niels Lohmann.
Vendored under MIT; see `third_party/nlohmann/LICENSE.MIT`.

## LibTorch

Use the license and third-party notices shipped in the downloaded official
LibTorch binary distribution. Runtime and weights are excluded from Git.

## PaddleOCR / RapidOCR

OCR model family: PP-OCRv4, PaddlePaddle Authors. ONNX exports and embedded
dictionary: RapidAI/RapidOCR, v3.9.2. The source model catalog publishes the
SHA-256 values recorded in `models/manifest.json`:
https://github.com/RapidAI/RapidOCR/blob/v3.9.2/python/rapidocr/default_models.yaml .

The native OCR preprocessing/decoding adapter follows the PaddleOCR/RapidOCR
contract. Copyright (c) 2020 PaddlePaddle Authors; RapidOCR contributors including
SWHL. Licensed under Apache-2.0; see `third_party/rapidocr/LICENSE`.
Changes: direct C++ ONNX Runtime sessions, fixed artifact verification, native
rectangle expansion, CTC decoder, and text/region association. No upstream Python
code is executed or shipped as a runtime dependency.

## ONNX Runtime / OpenCV

ONNX Runtime 1.23.2 is distributed under MIT. Its official package contains LICENSE
and ThirdPartyNotices.txt. OpenCV 4.10.0 is distributed under Apache-2.0 with notices
in the downloaded source LICENSE file and third-party subdirectories. The build
uses only the core/imgproc modules, with Python detection and bindings disabled.
These native packages remain under `.deps`, outside Git; preserve their notices
when distributing binaries. Original project code is licensed under MIT; adapted portions retain the applicable upstream terms.
