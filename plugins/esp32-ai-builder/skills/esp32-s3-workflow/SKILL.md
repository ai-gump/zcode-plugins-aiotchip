---
name: esp32-s3-workflow
description: 用 esp32-ai-builder 走通 ESP32-S3 开发全流程的方法论：环境搭建、创建项目、编译、烧录、串口监视。当用户想新建/编译/烧录 ESP32-S3 工程、查看开发板串口日志、安装 ESP-IDF，或问"怎么把代码跑到板子上"时使用。
---

# ESP32-S3 开发全流程（esp32-ai-builder）

锁定环境：**ESP32-S3 + ESP-IDF v5.5**，仅 macOS/Linux。所有操作通过插件的 `esp32` MCP 服务工具完成；长操作返回 `jobId`，用 `esp32_job_logs { jobId, cursor }` 轮询（每次把返回的 cursor 传回），直到 status 离开 running。

## 标准顺序

1. **环境检查**：任何开发动作前先 `esp32_env_check`。
   - `ready: true` → 继续。
   - 未找到 IDF → 询问用户偏好：受控安装（`esp32_idf_install`，下载约 1-2 GB，需网络与数分钟）或自装后在插件设置填 `idf_path`。
   - 版本不是 5.5.x → 如实告知插件锁定 v5.5，不要用其他版本硬跑。
2. **创建项目**：`esp32_create_project { name, target: "esp32s3" }`（模板 hello_world：LED 闪烁 + 芯片日志，LED 引脚由 sdkconfig `CONFIG_BLINK_GPIO` 控制）。
3. **set-target**：首次对项目执行 `esp32_set_target { project, target: "esp32s3" }`。
4. **编译**：`esp32_build { project }` → 轮询到终态。失败时从日志提取**文件、行号、报错**，直接修复代码或给出明确修改建议，然后重新编译；不要把整段日志甩给用户。
5. **烧录**：`esp32_flash { project, port? }`。烧录覆写设备 flash——**先向用户确认目标板与串口再执行**。串口留空自动取第一个检测到的。
6. **监视**：`esp32_monitor_start { port, baud? }` → `esp32_monitor_read` 增量查看 → `esp32_monitor_send` 可向设备发输入 → 结束用 `esp32_monitor_stop` 释放串口（串口被占用时烧录会失败）。

## 判断与修复速查

| 现象 | 处理 |
|-|-|
| 串口列表为空 | 检查 USB 线/驱动；S3 板用数据线（不是纯充电线）；macOS 看 `esp32_env_check` 的 serialPorts |
| 烧录报串口占用 | `esp32_monitor_stop` 停掉占用的监视作业，或让用户关闭其他串口工具 |
| 烧录连不上芯片（Failed to connect） | 让用户按住 BOOT 键再点烧录；检查是否选对串口 |
| Linux 权限错误 | 把用户加入 dialout 组或配置 udev 规则后重新插拔 |
| 监视乱码 | 波特率不对，常用 115200；确认 sdkconfig 的 CONFIG_ESP_CONSOLE_BAUDRATE |
| 发送后设备复位 | 部分驱动打开写端口会复位芯片，属于 V1 已知限制 |

## 边界（如实告知）

- 调试（OpenOCD/GDB 断点）**尚未接入**；需要断点时建议用户暂时使用 VS Code + ESP-IDF 扩展。
- `esp32_detect_devices` 探测会**复位目标芯片**。
- Windows 支持与 QEMU 未排期。
- 受控安装从 GitHub 拉取 ESP-IDF；网络受限时可用环境变量 `ESP32_IDF_REPO` 换国内镜像。
