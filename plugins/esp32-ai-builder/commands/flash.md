---
description: 用 esp32-ai-builder 烧录固件到开发板
argument-hint: [项目目录] [串口]
---

烧录 ESP32-S3 项目 $ARGUMENTS（格式：`项目目录 串口`，可只给目录，串口自动检测）。

步骤：
1. 烧录会**覆写开发板 flash**——先向用户确认目标串口与项目，得到明确同意后再继续。
2. 调用 `esp32_flash { project: "<目录>", port: "<串口，可选>" }`，拿到 jobId。
3. 用 `esp32_job_logs` 轮询到终态。
4. 失败常见原因：串口被占用（提示 esp32_monitor_stop 或拔插）、无权限（macOS 检查驱动，Linux 提示 udev/dialout）、芯片无响应（按住 BOOT 再烧）。
5. 成功后建议：调用 `esp32_monitor_start` 查看启动日志验证固件运行。
