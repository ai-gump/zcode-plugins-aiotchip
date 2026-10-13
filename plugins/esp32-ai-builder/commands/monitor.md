---
description: 用 esp32-ai-builder 打开串口监视查看设备日志
argument-hint: [串口] [波特率]
---

打开串口监视 $ARGUMENTS（格式：`串口 波特率`，可都留空：串口自动检测、波特率默认 115200）。

步骤：
1. 串口为空时先 `esp32_env_check` 取 serialPorts 列表；多于一个时让用户选。
2. 调用 `esp32_monitor_start { port, baud }`，拿到 jobId。
3. 持续 `esp32_monitor_read { jobId, cursor }`（回传 cursor）给用户看增量输出。
4. 用户想发命令时用 `esp32_monitor_send { jobId, text }`。
5. 结束时调用 `esp32_monitor_stop` 释放串口；分析日志里的 panic/backtrace 并给出修复建议。
