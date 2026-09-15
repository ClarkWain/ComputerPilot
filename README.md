# DesktopPilot

面向 AI agent 的原生 Windows 桌面自动化库与 MCP 服务，使用 C++20 和 CMake 构建。

DesktopPilot 将窗口、UI Automation 控件、截图和键鼠输入统一为结构化操作。Agent 可以先定位控件，再一次提交带验证条件的组合命令；系统 API 无法提供足够信息时，可选用原生视觉推理补充截图解析。

## 能力与特点

- **原生运行**：桌面操作、图像处理与可选模型推理不需要 Python 或 Node.js。
- **结构化定位**：窗口与控件使用会话引用，支持筛选、紧凑输出和按需读取详情。
- **组合操作**：顺序执行、前后条件核验、步骤引用、等待、取消及失败停止，减少 agent 往返。
- **窗口绑定**：实时窗口/客户区相对坐标；检查焦点、遮挡、窗口状态与可选尺寸约束。
- **文本表单**：原生字段填写、回读验证与剪贴板恢复；派发结果和验证结果分开返回。
- **可选视觉后端**：LibTorch 图标检测、ONNX Runtime OCR；模型按需下载。
- **轻量输出**：四位小数、去除尾零、紧凑查询与批处理摘要，减少重复数据。

这些机制改善可控性，但不保证任意应用的操作成功率。截图不是业务完成证明；UIA 支持程度、焦点变化、权限和应用实现都会影响结果。

## 快速开始

支持 Windows x64；构建需要 Visual Studio 2022 C++ 桌面工具、Windows SDK、CMake 3.29+ 和 PowerShell。预编译程序需要 Microsoft Visual C++ 2015–2022 x64 Runtime。

```powershell
cmake --preset core-only
cmake --build --preset core-only --parallel 4
ctest --preset core-only -LE interactive
.\build\core\Release\desktop-pilot.exe capabilities
.\build\core\Release\desktop-pilot.exe serve
```

Core 版包含窗口、UIA、截图、输入、表单和 MCP，不含模型推理。带视觉能力的构建见 [构建说明](docs/BUILDING.md)。GitHub Release 提供 core ZIP 和 SHA-256 校验文件，模型权重不随 Release 分发。

## 接入 MCP

将配置加入支持 MCP stdio 的客户端，替换为实际绝对路径：

```json
{
  "mcpServers": {
    "desktop-pilot": {
      "command": "C:/tools/DesktopPilot/bin/desktop-pilot.exe",
      "args": ["serve"]
    }
  }
}
```

启动程序的客户端必须处于目标应用所在的交互桌面。远程服务器或隔离桌面中的进程不能凭窗口引用接管用户桌面；锁屏场景不承诺可用。

六个入口：`computer_runtime`、`computer_query`、`computer_inspect`、`computer_act`、`computer_batch`、`computer_wait`。先查询 `runtime.capabilities`，再按返回能力调用。

- [MCP 配置与示例](docs/MCP.md)
- [操作参数参考](OPERATIONS.md)
- [协议、引用与错误语义](docs/PROTOCOL.md)
- [组合命令与窗口检查](BATCH-RELIABILITY.md)

## 在 C++ 中使用

提供 `DesktopPilot::Core`、`DesktopPilot::Desktop` 和 `DesktopPilot::Service` CMake target，通过 `add_subdirectory` 接入。直接库调用是同步的，MCP 的工作进程监督属于服务层。

```cpp
#include <desktop_pilot/service.hpp>
#include <iostream>

int main() {
    dp::Service service;
    std::cout << dp::dump_json(service.execute("window.list", dp::Json::object()));
}
```

完整可构建示例见 [examples/cpp](examples/cpp)。当前为 0.x，C++ ABI 与操作参数可能随版本演进；请固定版本，勿跨线程并发共享一个 Service 实例。

## Agent skill

仓库附带可复制安装的 [desktoppilot skill](skills/desktoppilot/SKILL.md)。它指导 agent 进行目标选择、使用已验证字段填写、处理会话引用和异常，并通过摘要结果减少无效交互。Skill 本身不安装或启动服务，仍需配置 MCP。

## 开发与发布

CI 在 Windows 上构建 core、运行非交互测试、编译 C++ 消费示例并验证分发包。真实桌面测试应在交互会话中单独运行。发布 `vX.Y.Z` 标签会触发 Release 工作流；版本必须与 CMake 项目版本一致。

详情见 [构建与发布](docs/BUILDING.md)、[更新记录](CHANGELOG.md) 和 [贡献指南](CONTRIBUTING.md)。

## 许可证

原创代码采用 [MIT License](LICENSE)。第三方代码和改编部分保留原许可证、署名及适用条件，详见 [第三方声明](THIRD_PARTY_NOTICES.md)。模型权重不因本项目的许可证而重新授权；下载或另行分发前应核对其模型许可。
