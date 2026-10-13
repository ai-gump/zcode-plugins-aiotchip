---
name: esp32-s3-overview
description: 查询 ESP32-S3 芯片规格与 esp32-ai-builder 插件当前能力。当用户询问 ESP32-S3 的参数、选型、外设、内存、文档链接，或想了解如何用 esp32-ai-builder 开始 ESP32-S3 开发、支持哪些芯片和 ESP-IDF 版本时使用。
---

# ESP32-S3 芯片资料与插件能力

esp32-ai-builder 已支持环境搭建、项目创建、编译、烧录与串口监视（见 esp32-s3-workflow 技能）。本技能聚焦芯片资料查询。工具来自插件的 `esp32` MCP 服务，随插件启用自动加载，无需额外配置。

## 工具

- `esp32_list_targets`：列出插件支持的芯片（当前仅 `esp32s3`）和锁定的 ESP-IDF 版本（v5.5）。回答"支持哪些芯片/什么版本"时先调用它。
- `esp32_chip_info`：传入 `target`（当前只接受 `esp32s3`），返回完整规格：CPU、内存、无线、GPIO 数量、USB/JTAG、AI 特性、常见开发板、最低 ESP-IDF 版本和官方文档链接。选型、规格对比、找 datasheet 时调用它。

## 边界（如实告知用户）

- `esp32_chip_info` 是静态目录数据，不连接真实芯片；读取已连接硬件信息请用 `esp32_detect_devices`（探测会复位目标芯片）。
- 调试（断点/GDB）尚未接入；Windows 与 QEMU 未排期。

## 回答方式

1. 规格类问题：调用 `esp32_chip_info`，按用户关注点（性能/内存/无线/外设）摘取字段回答，文档链接原样给出。
2. 选型类问题：先 `esp32_list_targets` 说明当前范围，再给 ESP32-S3 详情，并提示后续版本将扩展更多 target。
3. 开发流程类问题（编译/烧录/监视/装环境）：路由到 esp32-s3-workflow 技能的方法论，不要在本技能里重复。
