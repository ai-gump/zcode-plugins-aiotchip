# zcode-plugins-aiotchip

ZCode plugin marketplace for AIoT chip development. First plugin: **esp32-ai-builder** — end-to-end ESP32-S3 development (chip catalog, ESP-IDF 5.5 environment setup, project creation, build, flash, serial monitor).

面向 ZCode 的 AIoT 芯片开发插件市场，首发 **esp32-ai-builder**：ESP32-S3 端到端开发（芯片资料、ESP-IDF 5.5 环境、创建项目、编译、烧录、串口监视）。

## Install / 安装

ZCode → **插件市场 → 新增**，填入：

```text
ai-gump/zcode-plugins-aiotchip
```

或 CLI：

```sh
zcode plugins marketplace add ai-gump/zcode-plugins-aiotchip --scope user
zcode plugins install esp32-ai-builder@zcode-plugins-aiotchip --scope user
zcode plugins enable esp32-ai-builder@zcode-plugins-aiotchip --scope user
```

Scope: **ESP32-S3 only, ESP-IDF v5.5 only, macOS/Linux**. Debug (OpenOCD/GDB), Windows, and QEMU are deferred.

范围：仅 ESP32-S3、仅 ESP-IDF v5.5、仅 macOS/Linux；调试/Windows/QEMU 暂未排期。

## Layout / 结构

```text
marketplace.json               # 市场清单（宿主读取的唯一目录）
plugins/esp32-ai-builder/      # 安装产物：manifest、commands、skills、README、dist/
ui-plugins/esp32-ai-builder/   # 源码包（TypeScript MCP 服务 + MCP Apps 面板）
```

`plugins/<name>/` is what gets installed; `ui-plugins/<name>/` is the build source (build with `pnpm build` in the source package; the root of the upstream repo has the full toolchain and contract docs).
`plugins/<name>/` 是宿主实际安装的内容；`ui-plugins/<name>/` 是编译源码（在源码包内执行 `pnpm build` 可重建，完整构建契约见上游 zcode-plugins 仓库文档）。

## Versioning / 版本

Any change to installable content bumps the version in three places (`marketplace.json`, `plugins/<name>/.zcode-plugin/plugin.json`, `ui-plugins/<name>/package.json`) and rebuilds `plugins/<name>/dist/`. Published versions are immutable.
进入安装包的内容变化必须三处同步升级版本并重建 `dist/`；已发布版本不可复用。

Current: esp32-ai-builder **v0.2.1**.
