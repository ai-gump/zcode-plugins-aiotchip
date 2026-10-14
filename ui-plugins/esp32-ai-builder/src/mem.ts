// 内存日志解析与分析：标准协议 + 旧格式兼容。
//
// 标准协议（一行一条，设备按固定节奏打印）：
//   @@@MEM v1 sram  free=50176 min=41739 maxblk=20480 up=2279
//   @@@MEM v1 psram free=7840568 min=7709912 maxblk=7733248 up=2279
//   字段单位一律字节；up 为设备开机毫秒数（可选）；type 可扩展（sram/psram/dma…）
//
// 旧格式（learnpod 固件当前打印，自动兼容）：
//   I (2279) 系统监控: @@@内存  | screen=home network=ws_ready ... | 剩余:     49 KB | 历史最小:  41739 B | 最大块:  20480 B
//   I (2279) 系统监控: @@@PSRAM | 剩余:   7659 KB | 历史最小: 7840568 B | 最大块: 7733248 B
//   旧格式单位 KB/B 混用，统一折算为字节；开机毫秒取日志前缀 I (nnnn)。

export type MemType = "sram" | "psram";

export interface MemSample {
  type: MemType;
  free: number; // 字节
  min: number; // 历史最小，字节
  maxblk: number; // 最大连续块，字节
  up: number; // 设备开机毫秒（缺省 0）
  seq: number; // 样本序（解析顺序）
}

export interface KeyLine {
  level: "W" | "E" | null;
  text: string; // 已去 ANSI
}

export interface ParsedMemoryLog {
  samples: MemSample[];
  keyLines: KeyLine[];
  unknownMarkers: number; // 出现 @@@ 前缀但无法解析的行数（协议不匹配信号）
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function unitToBytes(value: number, unit: string): number {
  const v = Number(value);
  if (!Number.isFinite(v)) return NaN;
  const u = unit.toLowerCase();
  if (u === "kb" || u === "k") return v * 1024;
  if (u === "mb" || u === "m") return v * 1024 * 1024;
  return v; // B / 无单位
}

/** 解析一行；非内存行返回 null。 */
export function parseMemoryLine(rawLine: string): MemSample | null {
  const line = rawLine.replace(ANSI_RE, "").trimEnd();
  if (!line.includes("@@@")) return null;

  // 标准协议
  const std = /@@@MEM\s+(?:v1\s+)?([A-Za-z_]+)\s+free=(\d+)\s+min=(\d+)\s+maxblk=(\d+)(?:\s+up=(\d+))?/.exec(line);
  if (std) {
    const type = std[1].toLowerCase();
    if (type !== "sram" && type !== "psram") return null; // 其他类型暂不入曲线，计 unknown
    const upTail = /(?:^|\s)I\s*\((\d+)\)/.exec(line);
    return {
      type: type as MemType,
      free: Number(std[2]),
      min: Number(std[3]),
      maxblk: Number(std[4]),
      up: std[5] ? Number(std[5]) : upTail ? Number(upTail[1]) : 0,
      seq: 0,
    };
  }

  // 旧格式：@@@内存 / @@@PSRAM
  const isLegacy = /@@@(内存|PSRAM)/.exec(line);
  if (!isLegacy) return null;
  const type: MemType = isLegacy[1] === "PSRAM" ? "psram" : "sram";
  const free = /剩余:\s*([\d.]+)\s*(KB|B|K|M)?/i.exec(line);
  const min = /历史最小:\s*([\d.]+)\s*(KB|B|K|M)?/i.exec(line);
  const maxblk = /最大块:\s*([\d.]+)\s*(KB|B|K|M)?/i.exec(line);
  if (!free) return null;
  const upTail = /(?:^|\s)I\s*\((\d+)\)/.exec(line);
  return {
    type,
    free: unitToBytes(Number(free[1]), free[2] ?? "B"),
    min: min ? unitToBytes(Number(min[1]), min[2] ?? "B") : NaN,
    maxblk: maxblk ? unitToBytes(Number(maxblk[1]), maxblk[2] ?? "B") : NaN,
    up: upTail ? Number(upTail[1]) : 0,
    seq: 0,
  };
}

/** 是否关键日志（W/E 级或内存异常信号）； routine 的 @@@ 采样行不算。 */
export function isKeyLine(rawLine: string): boolean {
  const line = rawLine.replace(ANSI_RE, "").trimEnd();
  if (line.includes("@@@")) return false;
  if (/(?:^|[\s>])W\s*\(\d+\)/.test(line) || /(?:^|[\s>])E\s*\(\d+\)/.test(line)) return true;
  if (/\bERROR\b|\bWARN\b/.test(line)) return true;
  if (/MemFail|out of memory|OOM|alloc fail|core dump/i.test(line)) return true;
  return false;
}

export function parseMemoryLog(rawLog: string, keyLimit = 100): ParsedMemoryLog {
  const samples: MemSample[] = [];
  const keyLines: KeyLine[] = [];
  let unknownMarkers = 0;
  let seq = 0;
  for (const rawLine of rawLog.split("\n")) {
    const sample = parseMemoryLine(rawLine);
    if (sample) {
      sample.seq = seq++;
      samples.push(sample);
      continue;
    }
    const line = rawLine.replace(ANSI_RE, "").trimEnd();
    if (line.includes("@@@")) {
      unknownMarkers += 1;
      continue;
    }
    if (keyLines.length < keyLimit && isKeyLine(rawLine)) {
      const level = /(?:^|[\s>])E\s*\(\d+\)/.test(line) || /\bERROR\b/.test(line) ? "E" : "W";
      keyLines.push({ level, text: line });
    }
  }
  return { samples, keyLines, unknownMarkers };
}

export interface MemTypeAnalysis {
  count: number;
  latestFree: number | null;
  freeMinEver: number | null; // 观测期内 free 的最小值
  deviceMinLatest: number | null; // 设备上报的历史最小（最后一条）
  maxblkLatest: number | null;
  trendPct: number | null; // 最近 10 个样本均值 vs 前 10 个均值，百分比
  verdict: "正常" | "偏紧" | "持续下降" | null;
}

export function analyzeType(samples: MemSample[], tightBytes: number): MemTypeAnalysis {
  if (samples.length === 0) {
    return { count: 0, latestFree: null, freeMinEver: null, deviceMinLatest: null, maxblkLatest: null, trendPct: null, verdict: null };
  }
  const frees = samples.map((s) => s.free);
  const latestFree = frees[frees.length - 1];
  const freeMinEver = Math.min(...frees);
  const last = samples[samples.length - 1];
  const deviceMinLatest = Number.isFinite(last.min) ? last.min : null;
  const maxblkLatest = Number.isFinite(last.maxblk) ? last.maxblk : null;
  let trendPct: number | null = null;
  if (frees.length >= 6) {
    const half = Math.floor(frees.length / 2);
    const earlier = frees.slice(0, half);
    const recent = frees.slice(half);
    const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    const base = avg(earlier);
    trendPct = base > 0 ? Number((((avg(recent) - base) / base) * 100).toFixed(1)) : null;
  }
  let verdict: MemTypeAnalysis["verdict"] = "正常";
  if (latestFree < tightBytes) verdict = "偏紧";
  else if (trendPct !== null && trendPct <= -10) verdict = "持续下降";
  return {
    count: samples.length,
    latestFree,
    freeMinEver,
    deviceMinLatest,
    maxblkLatest,
    trendPct,
    verdict,
  };
}
