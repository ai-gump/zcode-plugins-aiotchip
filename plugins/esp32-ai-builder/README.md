# esp32-ai-builder

End-to-end ESP32-S3 development for ZCode: chip catalog, ESP-IDF 5.5 environment setup (detect or controlled install), project creation, build, flash, and serial monitor — driven by MCP tools and an interactive panel. Debug (OpenOCD/GDB) is on the roadmap.

简体中文文档见 [README_CN.md](README_CN.md)。

## Capabilities

| Tool | What it does |
|-|-|
| `esp32_list_targets` / `esp32_chip_info` | Supported chips (V1: `esp32s3`) and full ESP32-S3 spec sheet with official docs links. |
| `esp32_env_check` | Detects ESP-IDF v5.5, IDF python + pyserial, python3/git, serial ports; returns fix suggestions. |
| `esp32_idf_versions` / `esp32_idf_install` | Show the pin (v5.5 release branch, esp32s3) / controlled install (~1-2 GB download) into the plugin data directory. |
| `esp32_detect_devices` | Reads live chip info via esptool. SIDE EFFECT: resets the target chip. |
| `esp32_create_project` / `esp32_set_target` | New project from the bundled hello_world template; one-time `idf.py set-target`. |
| `esp32_build` / `esp32_flash` / `esp32_size` | Build / flash / size as background jobs (jobId + log tail tools). Flash **overwrites device flash**. |
| `esp32_job_status` / `esp32_job_logs` / `esp32_job_cancel` | Job management with cursor-based incremental logs. |
| `esp32_monitor_start/read/send/stop` | Serial monitor (pyserial helper from the IDF python env), one port at a time. |
| SDK config | `esp32_sdkconfig_get/set` read `sdkconfig.json` and write `sdkconfig.defaults` (+ patch active `sdkconfig`). |

The **ESP32 AI 开发台** panel (MCP Apps surface) exposes the same loop with three tabs: chip library (with "bring selection into the conversation"), build pipeline (env / set-target / build / flash with live logs), and serial monitor. Build and flash results also render an inline progress card in the conversation.

Slash commands: `/esp32:new-project`, `/esp32:build`, `/esp32:flash`, `/esp32:monitor`. Skills: `esp32-s3-overview` (chip Q&A), `esp32-s3-workflow` (full-loop methodology).

## Requirements

- ZCode desktop with MCP + MCP Apps support; `node` on `PATH`.
- macOS or Linux (Windows is deferred). bash available (default).
- ESP-IDF v5.5 either pre-installed (set `idf_path` in plugin settings, or auto-detected via `IDF_PATH` / `~/esp/esp-idf`) or installed by the plugin (`esp32_idf_install`, needs network; honors `ESP32_IDF_REPO` override for mirrors).
- No hardware needed for catalog/env/install; build needs IDF, flash/monitor need an ESP32-S3 board.

## Permissions, network, and side effects

- The MCP server is a local Node process per session; job processes run under your user.
- **Network**: only `esp32_idf_install` downloads (git clone of ESP-IDF from the configured repo plus toolchain downloads by its install script). Everything else is local.
- **Device side effects**: `esp32_flash` overwrites flash; `esp32_detect_devices` and probe tools reset the target. Confirm before running.
- **Data**: jobs, controlled installs, and toolchains live under the plugin data directory (`ZCODE_PLUGIN_DATA`); nothing is written outside the workspace, that directory, and the build outputs.

## Known limits (V1)

- Debug (OpenOCD/GDB), Windows, QEMU: deferred.
- `esp32_monitor_send` opens the port for writing, which resets some boards (driver behavior).
- One serial port is held by at most one monitor job per session.

## Local development

Source package: `ui-plugins/esp32-ai-builder/`; installed artifacts: `plugins/esp32-ai-builder/dist/`. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
python3 scripts/validate.py
```

Then add `dist/local-marketplace` as a marketplace source in ZCode and install `esp32-ai-builder`. Bump the version in all three places (`marketplace.json`, `.zcode-plugin/plugin.json`, source `package.json`) whenever installable content changes; published versions are immutable.

Manual smoke test of the MCP server:

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"manual","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"esp32_env_check","arguments":{}}}' \
  | node plugins/esp32-ai-builder/dist/server.mjs
```
