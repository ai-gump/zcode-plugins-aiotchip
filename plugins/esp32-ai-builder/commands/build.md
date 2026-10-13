---
description: 用 esp32-ai-builder 编译一个 ESP32-S3 项目
argument-hint: [项目目录]
---

编译 ESP32-S3 项目 $ARGUMENTS（为空时用当前工作区目录）。

步骤：
1. 调用 `esp32_build { project: "<目录>" }`，拿到 jobId。
2. 用 `esp32_job_logs { jobId, cursor }` 轮询（把上次返回的 cursor 传回），直到 status 不是 running。
3. 成功 → 汇总产物路径（`<项目>/build/<项目名>.bin`）并提示可以烧录。
4. 失败 → 从日志提取错误（文件、行号、报错原因），直接给出修复方案或修改代码后重新编译。
