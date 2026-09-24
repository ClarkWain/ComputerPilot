# Node 视觉模块迁移记录（2026-09-23）

## 当前实现范围

`node/src/vision` 已实现 PP-OCRv4 的模型 SHA-256 与内嵌字典校验、图片解码、BGR NCHW 归一化、检测与识别 ONNX 推理、CTC 解码、文字区域提取和旧结果结构的文字融合。`NodeVision.call('vision.ocr', {image, ocrModels, ocrMaxSide?})` 是给 Node 语义适配器用的**私有**业务操作，不增加公开 MCP 工具。模型在 `models/ocr/det.onnx` 与 `rec.onnx`，运行时为 `onnxruntime-node`。传入图片路径，返回 `textLines`、`elements`、`components` 等字段；默认保留 SHA-256 图片引用。

文字区域提取目前是 8 邻接连通域和轴对齐裁剪。旧 C++ 使用 OpenCV 的轮廓、最小旋转矩形、扩张和透视裁剪。因此当前实现适合水平 UI 文字，不具备旋转或透视文本的等价性。BGR 双线性缩放也未验证与 OpenCV 逐像素一致。模型中间推理可运行不等于所有图片上识别结果等价。

在已生成的固定 `build/release/fixtures/ui.png` 上，Node 返回 11 行，包含 `Create`、`Cancel` 和“车窗倒映着沿途的灯火”；旧 C++ 也为 11 行。对同一行的文字框，左上角多相差 1–3 像素，部分空格和标点有差异，例如 `Evening train／晚班列车` 与旧结果 `Eveningtrain/晚班列车`。已添加模型集成测试；当模型或测试图片缺失时测试会跳过，不能把跳过当成通过。当前可重现命令：

```powershell
cd node
npm run build
node --test dist/tests/vision/*.test.js
```

`NodeVision.call('vision.parse', {image, model})` 可接收已转换的 `.onnx` 路径，也支持旧私有协议中的 `.pt` 路径。传 `.pt` 时，先找同目录同名 `.onnx` 和 `.onnx.manifest.json`；发行包若将生成模型另放一处，可设置 `DP_OMNIPARSER_ONNX` 指向该 `.onnx`。加载时核验实际 `.pt` 哈希、manifest 的源模型哈希、ONNX 哈希、大小、算子集和六头契约。缺少转换产物返回 `conversion_required` 和 `dispatch:not_started`，不会在用户操作时偷偷转换或回退到 C++ 模型业务代码。直接传 `.onnx` 同样必须有配套 manifest，并验证 ONNX 哈希。

## OmniParser TorchScript → ONNX 实测

原模型 `models/icon_detect_v3/model.pt` 为 281,182,680 字节 TorchScript；`forward(image)` 返回三组 logits/distance，共六个张量。只读检查展开图的运算符未发现自定义算子。为验证转换，在忽略构建目录 `build/node-vision-python` 临时安装 `onnx`/`onnxscript`，没有改动原模型或项目依赖。

使用本机 PyTorch 2.10 CPU，`torch.onnx.export(..., opset_version=17, dynamo=False, dynamic_axes=...)` 成功生成 232,306,213 字节的动态尺寸 ONNX，文件位于 `build/node-vision-validation/omniparser-dynamic.onnx`。Node 的 `onnxruntime-node` 1.30 CPU 成功加载模型，并对 64×64 和 640×640 输入返回符合 YOLOv9 原始六头契约的形状。相同测试张量上的 PyTorch 与 Node ONNX Runtime 最大绝对差如下：

| 输入 | 六头最大绝对差 |
|---|---|
| 64×64 | 各头 ≤ 1.24×10⁻⁵ |
| 640×640 | 4.02×10⁻⁴、1.12×10⁻³、4.20×10⁻⁵、7.63×10⁻⁵、1.53×10⁻⁵、4.10×10⁻⁵ |

现已迁入旧 C++ 的两次量化 Lanczos3 letterbox、六头解码和分类 NMS。在仓库固定 `ui.png` 上，Node 与旧 C++ 均检出 4 个框；四框排序和类别一致，分数差小于 0.0001，坐标与宽高差小于 0.001 像素。这是**一个固定样本**的端到端等价，不代表所有尺寸与场景。后续仍须扩大样本，特别检查靠近 0.25 置信度及 0.7 NMS IoU 门槛的结果、不同长宽比、透明 PNG、WebP、性能、Windows 包体积和模型发布许可。

转换脚本是 `node/src/vision/convert_omniparser.py`。它校验原始 `.pt` 的 SHA-256，在指定目录生成动态 ONNX 与 provenance manifest；不会修改原模型。开发环境可在独立 Python 环境安装 PyTorch 2.10、`onnx` 和 `onnxscript` 后运行：

```powershell
python node/src/vision/convert_omniparser.py --output build/node-vision-validation/omniparser-dynamic.onnx
```

发布构建需要在受控环境运行相同脚本，将生成的 ONNX 和 manifest 作为一对文件纳入发行包，放在原 `.pt` 同目录同名路径或设置 `DP_OMNIPARSER_ONNX`，并在无 Python/Torch 的目标机上验证加载。**232 MB 生成模型不加入 Git**；目前也未接入默认发行包，因此未配置转换产物的 `.pt` 调用返回 `conversion_required`。转换脚本依赖的 Python 工具不属于最终 Node 运行时依赖。

## 建议接线

`node/src/index.ts` 创建单例 `NodeVision`，在传给 `ProfileEngine` 的 `NativeCall` 闭包中先分发 `vision.ocr`/`vision.parse` 到 `vision.call(operation, args, options?.signal)`，其余平台原语继续走原生 worker。`NodeVision` 缓存 OCR 和检测模型。ONNX Runtime 推理一旦开始没有实现硬取消；取消信号在推理前后检查，不能宣称能回滚中途推理。当前 `vision.ocr` 在 OCR 模型或识别失败时返回 `status:partial`、`components.ocr:failed` 与 `ocrError`，与旧服务的局部失败语义相近。`vision.parse` 若检测成功但可选 OCR 失败，会保留检测框并报告 OCR 局部失败。

OCR 单图实测只覆盖固定水平文本。Aseprite 菜单文字、非 ASCII 文件路径、多 DPI 截图、旋转文字及性能需要后续真实窗口验收。
