# 常用 Agent 接口参考（自动生成）

来源：AgentApi::tools()。不要手工修改参数表。重新生成：examples/onboarding/generate-reference.ps1 -Executable 实际程序。首次上手先读 MCP.md；此文件仅供查参。

## list_windows

List all open windows. No parameters. Read the returned titles and pids to identify the intended window_id; does not activate or resize.

无参数；传空对象 {}。

## get_window_state

Get controls by default; mode:image/both adds a screenshot capped at 1600 pixels. Basic point coordinates follow the returned coordinateSpace; screenshot coordinates map automatically. Optional region uses window-relative physical pixels for a lossless detail view (also capped at 1600). Restores focus unless activate:false.

| 字段 | 必填 | 类型/取值 |
|---|---|---|
| activate | 否 | boolean |
| mode | 否 | controls, image, both |
| region | 否 | object |
| window_id | 是 | string |

## execute_semantic

PREFERRED when get_window_state returns a matching profile. Execute 1..256 app actions using its examples. Omit profile to auto-select exactly one compatible profile; explicit ids are revalidated. Native execution manages controls, colors, focus and waits. Stops on failure; inspect the result before retrying.

| 字段 | 必填 | 类型/取值 |
|---|---|---|
| actions | 是 | array |
| profile | 否 | string |
| window_id | 是 | string |

## execute_batch

Execute basic actions on the last observed window. control_id clicks prefer direct UIA invocation; pointer input restores focus. Points use the last state's coordinateSpace (image_pixels when a screenshot was returned, otherwise window pixels). Mapping is internal. Stops on failure without replay.

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

### move

| 字段 | 必填 | 类型/取值 |
|---|---|---|
| delay_ms | 否 | integer |
| hold | 否 | left, right, middle |
| points | 是 | array |
| type | 是 | move |

point/from/to 均为 {x:整数,y:整数}，遵循最近观察的 coordinateSpace：有截图使用图片像素，仅 controls 使用窗口物理像素；程序自动转换，必须在观察范围内。click 的 point/control_id 必须二选一。count 为 1 或 2，actions 数量为 1..256。move.points 为 1..4096 个 [x,y] 整数对；hold 可选 left/right/middle，指定时至少两点：首点按下、连续移动、末点松开，省略则只移动。delay_ms 是动作前等待。完整机器可读定义见 agent-tools.schema.json；该文件由同一命令生成。
