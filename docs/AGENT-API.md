# 常用 Agent 接口参考（自动生成）

来源：node/src/mcp/tools.json。不要手工修改参数表。重新生成：examples/onboarding/generate-reference.ps1。首次上手先读 MCP.md；此文件仅供查参。

## list_windows

List all open windows. No parameters. Read structuredContent.windows titles and pids to identify the intended window_id; does not activate or resize. JSON is in structuredContent, not content.

无参数；传空对象 {}。

## get_window_state

Get compact controls and semantic profiles by default. JSON is in structuredContent; content contains only inline images. change_mode:delta returns only changes since this connection's last complete observation of the same window and view; the first call or a reset returns full state. Unchanged screenshots are omitted, including inline images; small changes may return a positioned capture.kind:patch with a fullPath. Input coordinates still use the full image frame. detail:full restores complete control fields and longer text, not a deeper or unlimited control tree. mode:image skips UI Automation and profile discovery; mode:both includes controls/profiles and a screenshot. Screenshots return a local capture.path by default; remote hosts need image_delivery:inline. Basic point coordinates follow the returned coordinateSpace; screenshot coordinates map automatically. Restores focus unless activate:false.

| 字段 | 必填 | 类型/取值 |
|---|---|---|
| change_mode | 否 | full, delta |
| activate | 否 | boolean |
| detail | 否 | compact, full |
| image_delivery | 否 | path, inline |
| max_edge | 否 | integer |
| mode | 否 | controls, image, both |
| region | 否 | object |
| window_id | 是 | string |

## execute_semantic

PREFERRED when get_window_state returns a matching profile. Execute 1..256 app actions using its examples. Omit profile to auto-select exactly one compatible profile; explicit ids are revalidated. Execution manages controls, colors, focus and waits. Read structuredContent.completed, failedIndex and dispatch before continuing; content carries images only. Stops on failure. Unknown or possibly_partial dispatch must be inspected, never blindly replayed.

| 字段 | 必填 | 类型/取值 |
|---|---|---|
| actions | 是 | array |
| profile | 否 | string |
| window_id | 是 | string |

## execute_batch

Execute basic actions on the last observed window. A standalone prepare_window action explicitly adjusts its client area in dip96 and returns the measured result; inspect again before input. control_id clicks prefer direct UIA invocation; pointer input restores focus. Points use the last state's coordinateSpace (image_pixels when a screenshot was returned, otherwise window pixels). Mapping is internal. Read structuredContent.completed, failedIndex and dispatch; JSON is not repeated in content. Stops on failure. Unknown or possibly_partial dispatch must be inspected, never blindly replayed.

| 字段 | 必填 | 类型/取值 |
|---|---|---|
| actions | 是 | array |
| window_id | 是 | string |

## action 类型

### click

| 字段 | 必填 | 类型/取值 |
|---|---|---|
| control_id | 否 | string |
| count | 否 | integer |
| delay_ms | 否 | integer |
| point | 否 | object |
| type | 是 | click |

### fill_text

| 字段 | 必填 | 类型/取值 |
|---|---|---|
| control_id | 是 | string |
| delay_ms | 否 | integer |
| text | 是 | string |
| type | 是 | fill_text |

### type_text

| 字段 | 必填 | 类型/取值 |
|---|---|---|
| delay_ms | 否 | integer |
| text | 是 | string |
| type | 是 | type_text |

### press_keys

| 字段 | 必填 | 类型/取值 |
|---|---|---|
| chord | 是 | string |
| delay_ms | 否 | integer |
| type | 是 | press_keys |

### drag

| 字段 | 必填 | 类型/取值 |
|---|---|---|
| delay_ms | 否 | integer |
| from | 是 | object |
| to | 是 | object |
| type | 是 | drag |

### prepare_window

| 字段 | 必填 | 类型/取值 |
|---|---|---|
| client_size | 是 | object |
| delay_ms | 否 | integer |
| minimum_client_size | 否 | object |
| type | 是 | prepare_window |

### move

| 字段 | 必填 | 类型/取值 |
|---|---|---|
| delay_ms | 否 | integer |
| hold | 否 | left, right, middle |
| points | 是 | array |
| type | 是 | move |

point/from/to 均为 {x:整数,y:整数}，遵循最近观察的 coordinateSpace：有截图使用图片像素，仅 controls 使用窗口物理像素；程序自动转换，必须在观察范围内。click 的 point/control_id 必须二选一。count 为 1 或 2，actions 数量为 1..256。move.points 为 1..4096 个 [x,y] 整数对；hold 可选 left/right/middle，指定时至少两点：首点按下、连续移动、末点松开，省略则只移动。delay_ms 是动作前等待。完整机器可读定义见 agent-tools.schema.json；该文件由同一命令生成。
