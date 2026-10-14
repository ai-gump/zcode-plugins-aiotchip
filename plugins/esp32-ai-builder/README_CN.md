# esp32-ai-builder

面向 ZCode 的 ESP32-S3 端到端开发插件：芯片资料、ESP-IDF 5.5 环境搭建（检测/受控安装）、项目创建、编译、烧录与串口监视——由 MCP 工具和交互面板承载。调试（OpenOCD/GDB）在路线图中。

English documentation: [README.md](README.md)。

## 能力总览

| 工具 | 作用 |
|-|-|
| `esp32_list_targets` / `esp32_chip_info` | 支持的芯片（V1：`esp32s3`）与 ESP32-S3 完整规格、官方文档链接。 |
| `esp32_env_check` | 检测 ESP-IDF v5.5、IDF python + pyserial、python3/git、串口列表；给出修复建议。 |
| `esp32_idf_versions` / `esp32_idf_install` | 查看锁定版本（v5.5 release 分支、esp32s3）/ 受控安装（约 1-2 GB 下载）到插件数据目录。 |
| `esp32_detect_devices` | 用 esptool 实读芯片信息。**副作用：会复位目标芯片**。 |
| `esp32_create_project` / `esp32_set_target` | 从内置 hello_world 模板建项目；一次性 `idf.py set-target`。 |
| `esp32_build` / `esp32_flash` / `esp32_size` | 编译/烧录/大小分析（后台作业：jobId + 日志游标工具）。烧录**覆写设备 flash**。 |
| `esp32_job_status` / `esp32_job_logs` / `esp32_job_cancel` | 作业管理，日志按字节游标增量读取。 |
| `esp32_monitor_start/read/send/stop` | 串口监视（IDF python 环境的 pyserial 助手），同串口同时仅一个监视作业。 |
| `esp32_uart_commands_get/set` | 面板自定义 UART 命令按钮（持久化到插件数据目录，最多 100 条）。 |
| `esp32_monitor_memory` | 解析监视流中的内存样本（标准/旧格式协议），返回曲线数据与趋势分析。 |
| sdkconfig | `esp32_sdkconfig_get/set` 读 `sdkconfig.json`、写 `sdkconfig.defaults`（并补丁活动的 `sdkconfig`）。 |

**ESP32 AI 开发台**面板（MCP Apps surface）以三个 tab 承载同一回路：芯片库（可"把选型信息带入对话"）、构建管线（环境/set-target/编译/烧录 + 实时日志）、串口监视（右侧自定义命令栏 + 底部终端式发送条）。编译和烧录的工具结果还会在对话里渲染内联进度卡。

斜杠命令：`/esp32:new-project`、`/esp32:build`、`/esp32:flash`、`/esp32:monitor`。技能：`esp32-s3-overview`（芯片问答）、`esp32-s3-workflow`（全流程方法论）。

## 内存日志协议

设备按固定节奏打印一行一个样本（单位一律**字节**），插件解析后绘制曲线并输出结构化分析：

```text
@@@MEM v1 <type> free=<n> min=<n> maxblk=<n> [up=<ms>]
# 示例
@@@MEM v1 sram  free=50176 min=41739 maxblk=20480 up=2279
@@@MEM v1 psram free=7840568 min=7709912 maxblk=7733248 up=2279
```

- `type`：`sram` / `psram`（可扩展）；`min` 为设备侧历史最小；`up` 为开机毫秒（可选）
- **旧格式兼容**：`@@@内存 | … | 剩余: N KB | 历史最小: N B | 最大块: N B` 与 `@@@PSRAM | …` 自动解析（KB/B 混用自动折算，开机毫秒取 `I (nnnn)` 前缀）
- Agent 结构化读取：调用 `esp32_monitor_memory { jobId }`（返回样本序列、趋势与判定，无需肉眼读日志）

## 依赖要求

- 支持 MCP 与 MCP Apps 的 ZCode 桌面端；`node` 在 `PATH` 上。
- macOS 或 Linux（Windows 暂未排期）；bash 可用（系统默认）。
- ESP-IDF v5.5：已安装（在插件设置填 `idf_path`，或经 `IDF_PATH` / `~/esp/esp-idf` 自动探测），或由插件受控安装（`esp32_idf_install`，需网络；可用 `ESP32_IDF_REPO` 覆盖为镜像源）。
- 目录/环境/安装类能力无需硬件；编译需要 IDF，烧录/监视需要 ESP32-S3 开发板。

## 权限、网络与副作用

- MCP 服务是随会话启动的本地 Node 进程；作业进程以当前用户身份运行。
- **网络**：仅 `esp32_idf_install` 联网（git clone ESP-IDF 及其 install.sh 下载工具链）；其余全部本地。
- **设备副作用**：`esp32_flash` 覆写 flash；`esp32_detect_devices` 等探测会复位目标芯片。执行前先确认。
- **数据**：作业日志、受控安装、工具链都在插件数据目录（`ZCODE_PLUGIN_DATA`）；除工作区、该目录和构建产物外不写任何位置。

## 已知限制（V1）

- 调试（OpenOCD/GDB）、Windows、QEMU 暂未排期。
- 发送输入经常驻监视进程的 stdin 通道，不重开端口——S3 内置 USB-Serial-JTAG 这类“控制线变化即复位”的板卡不会再被打进下载模式。
- 每个会话每串口同时仅一个监视作业。

## 本地开发

源码包：`ui-plugins/esp32-ai-builder/`；安装产物：`plugins/esp32-ai-builder/dist/`。在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm build
python3 scripts/validate.py
```

然后在 ZCode 中把 `dist/local-marketplace` 添加为插件来源并安装 `esp32-ai-builder`。任何进入安装包的内容变化时，三处版本必须同步升级（`marketplace.json`、`.zcode-plugin/plugin.json`、源码 `package.json`）；已发布版本不可复用。

MCP 服务手动冒烟：

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"manual","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"esp32_env_check","arguments":{}}}' \
  | node plugins/esp32-ai-builder/dist/server.mjs
```
