---
description: 用 esp32-ai-builder 在当前工作区创建 ESP32-S3 示例项目
argument-hint: [项目名]
---

用 esp32_create_project 在工作区创建名为 $ARGUMENTS 的 ESP32-S3 项目（模板 hello_world：LED 闪烁 + 芯片信息日志）。

步骤：
1. 若 $ARGUMENTS 为空，先询问用户项目名。
2. 调用 `esp32_create_project { name: "<项目名>", target: "esp32s3" }`；目录已存在时报错则告知用户改名或删除。
3. 创建成功后调用 `esp32_env_check` 检查环境：
   - 就绪 → 提示用户可以直接说"编译 <项目名>"；
   - 未就绪 → 按返回的 suggestions 给出修复路径（受控安装 esp32_idf_install 或在插件设置里填 idf_path）。
