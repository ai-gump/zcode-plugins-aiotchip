// ESP-IDF 环境管理：探测、版本校验、子进程环境构造。
// V1 双锁定（esp32s3 + v5.5）；V1 仅 macOS/Linux（export.sh 为 bash 脚本）。
import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export const PINNED_IDF_BRANCH = "release/v5.5";
export const PINNED_IDF_VERSION = "5.5";
export const DEFAULT_IDF_REPO = "https://github.com/espressif/esp-idf.git";
export const CHINA_MIRROR_HINT =
  "网络受限时可用国内镜像（如 https://jihulab.com/esp-mirror/espressif/esp-idf.git），通过环境变量 ESP32_IDF_REPO 覆盖。";

export const VERSION_HEADER = join("components", "esp_common", "include", "esp_idf_version.h");

export interface ResolvedIdf {
  path: string;
  version: string | null;
  meetsPinned: boolean;
  source: "userConfig" | "IDF_PATH" | "plugin-data" | "default";
}

/** 探测顺序：userConfig 注入的环境变量 → IDF_PATH → 插件数据目录的受控安装 → ~/esp/esp-idf。 */
export function resolveIdf(env: NodeJS.ProcessEnv, dataDir: string): ResolvedIdf | null {
  const candidates: Array<[string, ResolvedIdf["source"]]> = [
    [env.ESP32_IDF_PATH ?? "", "userConfig"],
    [env.IDF_PATH ?? "", "IDF_PATH"],
    [join(dataDir, "idf", "v5.5"), "plugin-data"],
    [join(homedir(), "esp", "esp-idf"), "default"],
  ];
  for (const [raw, source] of candidates) {
    const p = raw?.trim();
    if (!p || !existsSync(join(p, VERSION_HEADER))) continue;
    const version = readIdfVersion(p);
    return { path: p, version, meetsPinned: isPinned(version), source };
  }
  return null;
}

/** 从 esp_idf_version.h 解析 x.y.z，无需 source export.sh。 */
export function readIdfVersion(idfPath: string): string | null {
  const file = join(idfPath, VERSION_HEADER);
  if (!existsSync(file)) return null;
  const content = readFileSync(file, "utf8");
  const grab = (name: string): number =>
    Number(new RegExp(`#define\\s+${name}\\s+(\\d+)`).exec(content)?.[1] ?? "0");
  const major = grab("ESP_IDF_VERSION_MAJOR");
  const minor = grab("ESP_IDF_VERSION_MINOR");
  const patch = grab("ESP_IDF_VERSION_PATCH");
  if (!major) return null;
  return `${major}.${minor}.${patch}`;
}

export function isPinned(version: string | null): boolean {
  return version?.startsWith(`${PINNED_IDF_VERSION}.`) ?? false;
}

/** 受控安装的工具链目录固定在插件数据内；用户自有安装沿用 IDF_TOOLS_PATH / ~/.espressif。 */
export function resolveToolsPath(
  env: NodeJS.ProcessEnv,
  dataDir: string,
  idfPath: string | null,
): string {
  if (env.ESP32_IDF_TOOLS_PATH?.trim()) return env.ESP32_IDF_TOOLS_PATH.trim();
  if (env.IDF_TOOLS_PATH?.trim()) return env.IDF_TOOLS_PATH.trim();
  if (idfPath && idfPath.startsWith(dataDir)) return join(dataDir, "tools");
  return join(homedir(), ".espressif");
}

/** IDF python 虚拟环境（pyserial / esptool 所在）：IDF_TOOLS_PATH/python_env/idfX/bin/python。 */
export async function resolveIdfPython(toolsPath: string): Promise<string | null> {
  const envRoot = join(toolsPath, "python_env");
  if (!existsSync(envRoot)) return null;
  for (const entry of (await readdir(envRoot)).sort()) {
    if (!entry.startsWith("idf")) continue;
    for (const name of ["bin/python", "bin/python3"]) {
      const candidate = join(envRoot, entry, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export interface ProbeResult {
  ok: boolean;
  output: string;
}

/** 短命令（探测类）：bash -lc 执行、限时、回收输出。 */
export function runCapture(
  command: string,
  options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "bash",
      ["-lc", command],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 15000,
        maxBuffer: 1024 * 1024,
        env: options.env ? { ...process.env, ...options.env } : process.env,
      },
      (error, stdout, stderr) => {
        resolve({ ok: !error, output: stripAnsi(`${stdout}${stderr}`).slice(-16 * 1024) });
      },
    );
    child.on("error", () => resolve({ ok: false, output: "failed to spawn bash" }));
  });
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 作业用 idf.py 命令串：source export.sh 后在项目目录执行。 */
export function idfJobCommand(projectDir: string, idfArgs: string): string {
  return [
    "set -e",
    'test -f "$IDF_PATH/export.sh" || { echo "ESP-IDF export.sh not found; run esp32_env_check"; exit 2; }',
    'source "$IDF_PATH/export.sh" >/dev/null',
    `cd ${shellQuote(projectDir)}`,
    `idf.py ${idfArgs}`,
  ].join("\n");
}

/** 受控安装命令：浅克隆 release/v5.5 + 仅 esp32s3 工具链；父目录与工具链路径由调用方通过环境传入。 */
export function idfInstallCommand(destDir: string, repo: string): string {
  const dest = shellQuote(destDir);
  return [
    "set -e",
    `test ! -e ${dest} || { echo "destination already exists: ${destDir}"; exit 3; }`,
    `git clone --depth 1 --recursive --shallow-submodules --branch ${PINNED_IDF_BRANCH} ${shellQuote(repo)} ${dest}`,
    `cd ${dest}`,
    "./install.sh esp32s3",
  ].join("\n");
}

export function assertPosix(): void {
  if (platform() === "win32") {
    throw new Error("esp32-ai-builder V1 仅支持 macOS/Linux（Windows 支持暂未排期）。");
  }
}
