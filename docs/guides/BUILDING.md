# 构建与发布

## Core：不下载模型

Windows x64，Visual Studio 2022（C++ 桌面开发和 Windows SDK），CMake 3.29+，PowerShell。

```powershell
cmake --preset core-only
cmake --build --preset core-only --parallel 4
ctest --preset core-only -LE interactive
```

真实桌面测试会创建测试窗口并使用焦点/剪贴板，在可交互会话单独执行：

```powershell
ctest --preset core-only -L interactive
```

## 可选图标检测与 OCR

```powershell
cmake -P cmake/bootstrap.cmake
cmake -P cmake/bootstrap-ocr.cmake
cmake --preset windows-release
cmake --build --preset windows-release --parallel 4
ctest --preset windows-release -LE interactive
```

下载使用固定版本和 SHA-256。检测使用 LibTorch CPU 和固定 TorchScript 权重；OCR 使用 ONNX Runtime、OpenCV core/imgproc 和 PP-OCRv4。下载地址、权重大小与摘要见 models/manifest.json。权重、运行库和中间文件不进入 Git。图标描述大模型不包含在此发行版中。

## C++ 消费示例

```powershell
cmake -S examples/cpp -B build/consumer -G "Visual Studio 17 2022" -A x64
cmake --build build/consumer --config Release --parallel 4
.\build\consumer\Release\desktop-pilot-example.exe
```

`add_subdirectory` 提供 `DesktopPilot::Core`、`DesktopPilot::Desktop`、`DesktopPilot::Service`。当前不提供稳定 ABI 或安装式 find_package SDK。

## 分发包

```powershell
cmake -DDP_BINARY_DIR=build/core/Release -DDP_PACKAGE_DIR=out/dist/DesktopPilot -P cmake/package.cmake
.\out\dist\DesktopPilot\bin\desktop-pilot.exe capabilities
```

输出目录必须不存在，防止旧模型或运行库混入新包。分发包含程序、所选构建目录的 DLL、许可证、MCP/操作文档和 skill；不包含模型及本机配置。配置中的安装路径由使用者填写。

## GitHub Actions 与 Release

- `build.yml`：push、pull request、手动触发；构建 core、非交互测试、C++ 消费示例、打包上传。
- `release.yml`：推送 `vX.Y.Z` 标签触发；检查标签与 CMake 版本一致，重新构建测试，再上传 ZIP 和 SHA-256。
- Release 工作流复用构建流程，只在发布 job 授予 contents:write。
- CI 的非交互测试不等于真实应用验收；模型后端在安装依赖后本地或专用 Windows runner 验证。

当前版本为 0.4.0。标签发布前同步 CMake、CLI capabilities、MCP serverInfo 的版本号，检查 CHANGELOG、第三方声明和仓库待提交内容。推送 `v0.4.0` 后等待 Release 工作流成功，确认 ZIP 与 SHA256SUMS.txt 已附加到该版本；仅推送标签不代表发布完成。
## 截图编码依赖

默认开启 `DP_WITH_WEBP`，首次配置会下载并校验 libwebp 1.6.0 源码，静态链接编码器；发行包包含许可证。离线构建可预先放置 `.deps/downloads/libwebp-1.6.0.tar.gz`，或通过 `-DDP_WITH_WEBP=OFF` 使用 PNG。格式压缩减少传输字节；图像 token 的减少主要依靠限制分辨率、局部裁剪和减少截图次数，不能按文件大小直接推算。
