// 芯片静态目录（M0）。V1 仅收录 ESP32-S3；数据结构按 target 可扩展，新增芯片只需在
// CATALOG 增加条目并同步 SUPPORTED_TARGETS，不需要改动工具签名。
export const PINNED_IDF_VERSION = "5.5";

export const SUPPORTED_TARGETS = ["esp32s3"] as const;

export type TargetId = (typeof SUPPORTED_TARGETS)[number];

export interface TargetSpec {
  id: TargetId;
  displayName: string;
  summary: string;
  cpu: string;
  sram: string;
  rom: string;
  psram: string;
  flash: string;
  wireless: string[];
  gpioCount: number;
  usb: string;
  jtag: string;
  highlights: string[];
  devkits: string[];
  minIdfVersion: string;
  docs: { label: string; url: string }[];
}

export const CHIP_CATALOG: Record<TargetId, TargetSpec> = {
  esp32s3: {
    id: "esp32s3",
    displayName: "ESP32-S3",
    summary: "双核 Xtensa LX7，带 AI 向量指令与内置 USB-Serial-JTAG，是边缘 AI 与人机交互场景的主力型号。",
    cpu: "双核 Xtensa LX7，最高 240 MHz",
    sram: "512 KB",
    rom: "384 KB",
    psram: "外接，最高 16 MB（Octal / Quad SPI）",
    flash: "外接，最高 16 MB",
    wireless: ["Wi-Fi 4（802.11 b/g/n，2.4 GHz）", "Bluetooth 5 / Bluetooth LE"],
    gpioCount: 45,
    usb: "USB OTG + 内置 USB-Serial-JTAG",
    jtag: "内置 USB-Serial-JTAG，调试无需外接 JTAG 探针",
    highlights: [
      "AI 向量指令扩展（点积、FFT 加速），适合端侧语音/视觉推理",
      "LCD/CAM 外设与 Octal PSRAM，适合带屏与摄像头应用",
      "内置 USB-Serial-JTAG：一根 USB 线即可供电、烧录、监视与调试",
    ],
    devkits: ["ESP32-S3-DevKitC-1", "ESP32-S3-DevKitM-1"],
    minIdfVersion: PINNED_IDF_VERSION,
    docs: [
      { label: "Datasheet (EN)", url: "https://www.espressif.com/sites/default/files/documentation/esp32-s3_datasheet_en.pdf" },
      { label: "Datasheet (CN)", url: "https://www.espressif.com/sites/default/files/documentation/esp32-s3_datasheet_cn.pdf" },
      { label: "Technical Reference Manual (EN)", url: "https://www.espressif.com/sites/default/files/documentation/esp32-s3_technical_reference_manual_en.pdf" },
    ],
  },
};
