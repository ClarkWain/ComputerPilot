"""Convert the pinned OmniParser TorchScript detector to a Node-loadable ONNX artifact.

Requires Python with torch 2.10, onnx and onnxscript. Writes only the requested
output and its provenance manifest; the original model is read-only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import time

import torch


SOURCE_SHA256 = "11c6cbb77f22569fab22d86c76407a83ec81ab89dbfe28279854822d6e3fb00c"
ROOT = Path(__file__).resolve().parents[3]


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT / "models/icon_detect_v3/model.pt")
    parser.add_argument("--output", type=Path,
                        default=ROOT / "build/node-vision-validation/omniparser-dynamic.onnx")
    args = parser.parse_args()
    source = args.source.resolve()
    output = args.output.resolve()
    if source == output or output == source.with_suffix(".pt"):
        parser.error("Output must not replace the source TorchScript model")
    source_sha = digest(source)
    if source_sha != SOURCE_SHA256:
        raise RuntimeError(f"Unsupported OmniParser source SHA-256: {source_sha}")
    model = torch.jit.load(str(source), map_location="cpu").eval()
    torch.set_num_threads(4)
    sample = torch.zeros(1, 3, 64, 64, dtype=torch.float32)
    dynamic = {"image": {2: "height", 3: "width"}}
    for index in range(6):
        dynamic[f"head{index}"] = {2: f"height_{index // 2}", 3: f"width_{index // 2}"}
    output.parent.mkdir(parents=True, exist_ok=True)
    start = time.perf_counter()
    torch.onnx.export(model, sample, str(output), opset_version=17, dynamo=False,
                      input_names=["image"], output_names=[f"head{i}" for i in range(6)],
                      dynamic_axes=dynamic, do_constant_folding=True)
    manifest = {
        "schemaVersion": 1,
        "sourceSha256": source_sha,
        "onnxSha256": digest(output),
        "onnxBytes": output.stat().st_size,
        "torchVersion": torch.__version__,
        "opset": 17,
        "contract": "yolov9_raw_logits_distances_3_scales",
        "dynamicImageAxes": [2, 3],
    }
    manifest_path = output.with_name(output.name + ".manifest.json")
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(output), "manifest": str(manifest_path),
                      "seconds": round(time.perf_counter() - start, 3), **manifest}))


if __name__ == "__main__":
    main()
