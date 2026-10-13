// 工具契约与共享常量：工具名、UI 资源地址、_meta.ui 约定、zod schema。
// 工具出参约定：content[0].text 给模型读的摘要；structuredContent 给面板/程序消费。
import { z } from "zod";
import { SUPPORTED_TARGETS, type TargetId } from "./chip-catalog";

export const PLUGIN_NAME = "esp32-ai-builder";
export const PANEL_URI = `ui://${PLUGIN_NAME}/panel.html`;
export const CARD_URI = `ui://${PLUGIN_NAME}/card.html`;

/** 模型与面板都可调；缺省（不声明）时只有模型可见。 */
export const MODEL_AND_APP = { ui: { visibility: ["model", "app"] } } as const;

/** build/flash 结果内联作业卡片。 */
export const JOB_CARD_META = {
  ui: { resourceUri: CARD_URI, visibility: ["model", "app"], prefersBorder: true },
} as const;

export const TargetArg = z.enum(SUPPORTED_TARGETS).describe("Chip target id, e.g. esp32s3");
export type TargetArg = z.infer<typeof TargetArg>;

export interface JobRef {
  jobId: string;
  kind: string;
  status: string;
  logHint: string;
}

export function jobRef(meta: { id: string; kind: string; status: string }): JobRef {
  return {
    jobId: meta.id,
    kind: meta.kind,
    status: meta.status,
    logHint: `用 esp32_job_logs { jobId: "${meta.id}" } 跟踪输出，esp32_job_status 查询状态。`,
  };
}

export function projectSummary(tool: string): string {
  return `${tool} 的 project 参数既可以是工作区内的相对目录名，也可以是绝对路径；目录必须包含 CMakeLists.txt。`;
}

export type { TargetId };
