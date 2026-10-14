#!/usr/bin/env node
// esp32-ai-builder MCP 服务。
// V1 范围（esp32-plugin-plan.md 定稿）：ESP32-S3 + ESP-IDF v5.5，macOS/Linux。
// 环境搭建（检测/受控安装）、项目创建、编译、烧录、串口监视；调试暂不排期（D5）。
// stdout 只输出 MCP 协议消息；诊断日志走 stderr。
import { mkdir, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CHIP_CATALOG, PINNED_IDF_VERSION, SUPPORTED_TARGETS } from "./chip-catalog";
import {
  CARD_URI,
  JOB_CARD_META,
  MODEL_AND_APP,
  PANEL_URI,
  TargetArg,
  jobRef,
} from "./contract";
import {
  cancelJob,
  getJobChild,
  patchJobMeta,
  readJobLogs,
  readJobMeta,
  reapStaleJobs,
  startJob,
} from "./jobs";
import {
  CHINA_MIRROR_HINT,
  DEFAULT_IDF_REPO,
  PINNED_IDF_BRANCH,
  assertPosix,
  idfInstallCommand,
  idfJobCommand,
  isPinned,
  resolveIdf,
  resolveIdfPython,
  resolveToolsPath,
  runCapture,
  stripAnsi,
} from "./idf";
import { listSerialPorts } from "./serial";

const PLUGIN_VERSION = "0.6.0";
const HTML_MIME = "text/html;profile=mcp-app";
const DIST_DIR = dirname(fileURLToPath(import.meta.url));

const dataDir = process.env.ZCODE_PLUGIN_DATA?.trim() || join(DIST_DIR, "data");
const workspaceRoot =
  process.env.ZCODE_WORKSPACE_ROOT?.trim() || process.env.ZCODE_PROJECT_DIR?.trim() || process.cwd();

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function resolveProjectDir(project: string): string {
  const dir = isAbsolute(project) ? project : join(workspaceRoot, project);
  if (!existsSync(join(dir, "CMakeLists.txt"))) {
    throw new Error(
      `项目目录不存在或缺少 CMakeLists.txt：${dir}。` +
        "可先用 esp32_create_project 创建，或在面板“项目目录”下拉里选择已发现的项目。",
    );
  }
  return dir;
}

function idfEnv(toolsPath: string): Record<string, string> {
  return { IDF_TOOLS_PATH: toolsPath };
}

interface IdfContext {
  idfPath: string;
  toolsPath: string;
  idfPython: string | null;
}

/** 作业/探测类工具的公共前置：IDF v5.5 就绪才继续；失败时把修复建议抛回给模型。 */
async function requireIdf(): Promise<IdfContext> {
  assertPosix();
  const idf = resolveIdf(process.env, dataDir);
  if (!idf) {
    throw new Error(
      "未找到 ESP-IDF。修复方式（任选其一）：① 在插件设置里把 userConfig.idf_path 指向 ESP-IDF 5.5 安装目录；" +
        "② 调用 esp32_idf_install 受控安装 v5.5 到插件数据目录（约 1-2 GB，需要网络）。" +
        `安装前可先调 esp32_env_check 查看缺失项。${CHINA_MIRROR_HINT}`,
    );
  }
  if (!isPinned(idf.version)) {
    throw new Error(
      `检测到 ESP-IDF ${idf.version ?? "未知版本"}（${idf.path}），本插件锁定 v${PINNED_IDF_VERSION}。` +
        "请切换安装或在插件设置中把 userConfig.idf_path 指向 v5.5 目录。",
    );
  }
  const toolsPath = resolveToolsPath(process.env, dataDir, idf.path);
  const idfPython = await resolveIdfPython(toolsPath);
  return { idfPath: idf.path, toolsPath, idfPython };
}

const serialLock = new Map<string, string>();

const server = new McpServer(
  { name: "esp32-ai-builder", version: PLUGIN_VERSION },
  { capabilities: { tools: {} } },
);

/* ---------------------------------- 芯片目录（M0） ---------------------------------- */

server.registerTool(
  "esp32_list_targets",
  {
    title: "List supported ESP32 targets",
    description:
      "List the ESP32 targets supported by esp32-ai-builder with a one-line positioning for each. " +
      `V1 scope is ESP32-S3 only; the plugin pins ESP-IDF v${PINNED_IDF_VERSION}.`,
    inputSchema: {},
    _meta: MODEL_AND_APP,
  },
  () => {
    const targets = SUPPORTED_TARGETS.map((id) => ({
      id,
      displayName: CHIP_CATALOG[id].displayName,
      summary: CHIP_CATALOG[id].summary,
      pinnedIdfVersion: PINNED_IDF_VERSION,
    }));
    return {
      content: [
        {
          type: "text",
          text: `Supported targets: ${targets.map((t) => t.displayName).join(", ")}. ESP-IDF pinned to v${PINNED_IDF_VERSION}.`,
        },
      ],
      structuredContent: { pinnedIdfVersion: PINNED_IDF_VERSION, targets },
    };
  },
);

server.registerTool(
  "esp32_chip_info",
  {
    title: "Get ESP32 chip details",
    description:
      "Get the full spec sheet of a supported ESP32 target: CPU, memory, wireless, GPIO count, USB/JTAG, " +
      "AI highlights, common devkits, minimum ESP-IDF version, and official documentation links. " +
      "Use esp32_list_targets first to see which targets exist.",
    inputSchema: { target: TargetArg },
    _meta: MODEL_AND_APP,
  },
  ({ target }) => {
    const spec = CHIP_CATALOG[target];
    return {
      content: [
        {
          type: "text",
          text: `${spec.displayName}: ${spec.cpu}, ${spec.sram} SRAM, ${spec.gpioCount} GPIOs. Docs: ${spec.docs.map((d) => d.url).join(" | ")}`,
        },
      ],
      structuredContent: { pinnedIdfVersion: PINNED_IDF_VERSION, spec },
    };
  },
);

/* ---------------------------------- 环境（M1/M3） ---------------------------------- */

server.registerTool(
  "esp32_env_check",
  {
    title: "Check ESP32 development environment",
    description:
      "Check the ESP32 development environment on this machine: whether ESP-IDF v5.5 is installed and where, " +
      "whether the IDF Python environment with pyserial exists, whether python3/git are available, " +
      "and which serial ports are present. Returns concrete fix suggestions; run this first.",
    inputSchema: {},
    _meta: MODEL_AND_APP,
  },
  async () => {
    assertPosix();
    const idf = resolveIdf(process.env, dataDir);
    const toolsPath = resolveToolsPath(process.env, dataDir, idf?.path ?? null);
    const idfPython = await resolveIdfPython(toolsPath);
    const [pythonProbe, gitProbe, serialProbe, pyserialProbe] = await Promise.all([
      runCapture("command -v python3 >/dev/null && python3 --version"),
      runCapture("command -v git >/dev/null && git --version"),
      listSerialPorts().then(
        (ports) => ({ ok: true, output: ports.join("\n") }),
        (error: unknown) => ({ ok: false, output: String(error) }),
      ),
      idfPython
        ? runCapture(`${shellQuote(idfPython)} -c "import serial; print(serial.__version__)"`, { timeoutMs: 10000 })
        : Promise.resolve({ ok: false, output: "IDF python environment not found" }),
    ]);
    const ready = Boolean(idf && isPinned(idf.version) && pyserialProbe.ok);
    const suggestions: string[] = [];
    if (!idf) {
      suggestions.push(
        "未找到 ESP-IDF：可调用 esp32_idf_install 受控安装 v5.5，或在插件设置里把 userConfig.idf_path 指向已有安装。",
      );
    } else if (!isPinned(idf.version)) {
      suggestions.push(`ESP-IDF 版本为 ${idf.version ?? "未知"}，本插件锁定 v${PINNED_IDF_VERSION}；请切换到 v5.5 安装。`);
    }
    if (!idfPython) suggestions.push(`未找到 IDF python 虚拟环境（${toolsPath}/python_env）；完成一次 ESP-IDF 安装后会自动生成。`);
    if (idfPython && !pyserialProbe.ok) suggestions.push("IDF python 缺少 pyserial；在该环境执行 pip install pyserial，或重跑 ESP-IDF install.sh。");
    if (!pythonProbe.ok) suggestions.push("缺少 python3（ESP-IDF 依赖）；macOS: brew install python3。");
    if (!gitProbe.ok) suggestions.push("缺少 git（受控安装依赖）；macOS: xcode-select --install。");
    const structured = {
      ready,
      idf: idf
        ? { path: idf.path, version: idf.version, meetsPinned: isPinned(idf.version), source: idf.source }
        : null,
      idfPython,
      pyserial: pyserialProbe.ok ? pyserialProbe.output.trim() : null,
      python3: pythonProbe.ok ? pythonProbe.output.trim() : null,
      git: gitProbe.ok ? gitProbe.output.trim() : null,
      idfToolsPath: toolsPath,
      serialPorts: serialProbe.ok ? serialProbe.output.split("\n").filter(Boolean) : [],
      suggestions,
    };
    return {
      content: [
        {
          type: "text",
          text: ready
            ? `环境就绪：ESP-IDF ${structured.idf?.version} @ ${structured.idf?.path}；串口 ${structured.serialPorts.length} 个。`
            : `环境未就绪。${suggestions.join(" ")}`,
        },
      ],
      structuredContent: structured,
    };
  },
);

server.registerTool(
  "esp32_idf_versions",
  {
    title: "Show pinned ESP-IDF version",
    description:
      "Show the ESP-IDF version this plugin is locked to (V1: v5.5 release branch, esp32s3 only), " +
      "the git repository used by esp32_idf_install, and the China mirror override.",
    inputSchema: {},
    _meta: MODEL_AND_APP,
  },
  () => ({
    content: [
      {
        type: "text",
        text: `Pinned ESP-IDF: ${PINNED_IDF_BRANCH} (v${PINNED_IDF_VERSION}), target esp32s3. Repo: ${DEFAULT_IDF_REPO}. ${CHINA_MIRROR_HINT}`,
      },
    ],
    structuredContent: {
      branch: PINNED_IDF_BRANCH,
      version: PINNED_IDF_VERSION,
      repo: process.env.ESP32_IDF_REPO?.trim() || DEFAULT_IDF_REPO,
      mirrorHint: CHINA_MIRROR_HINT,
    },
  }),
);

server.registerTool(
  "esp32_idf_install",
  {
    title: "Install pinned ESP-IDF (v5.5)",
    description:
      "Install ESP-IDF v5.5 (release branch, esp32s3 toolchain only) into the plugin data directory via git " +
      "clone plus install.sh. Downloads roughly 1-2 GB and needs network access; takes several minutes. " +
      "Run esp32_env_check afterwards. Fails if a previous controlled install already exists.",
    inputSchema: {},
    _meta: { ...MODEL_AND_APP, ...JOB_CARD_META },
  },
  async () => {
    assertPosix();
    if (resolveIdf(process.env, dataDir)?.source === "plugin-data") {
      throw new Error("插件数据目录里已有受控安装（data/idf/v5.5）；重复安装请先删除该目录。");
    }
    if (existsSync(join(dataDir, "idf", "v5.5"))) {
      throw new Error(`目录已存在：${join(dataDir, "idf", "v5.5")}；先删除它再安装。`);
    }
    const repo = process.env.ESP32_IDF_REPO?.trim() || DEFAULT_IDF_REPO;
    await mkdir(join(dataDir, "idf"), { recursive: true });
    const meta = await startJob({
      dataDir,
      kind: "idf-install",
      title: `Install ESP-IDF ${PINNED_IDF_BRANCH} (esp32s3)`,
      command: idfInstallCommand(join(dataDir, "idf", "v5.5"), repo),
      env: idfEnv(join(dataDir, "tools")),
    });
    return {
      content: [
        {
          type: "text",
          text: `ESP-IDF 安装作业已启动（约 1-2 GB 下载，需数分钟）。${jobRef(meta).logHint} 完成后用 esp32_env_check 验证。`,
        },
      ],
      structuredContent: { ...jobRef(meta), repo },
    };
  },
);

/* ---------------------------------- 项目（M1） ---------------------------------- */

server.registerTool(
  "esp32_create_project",
  {
    title: "Create an ESP32-S3 project",
    description:
      "Create a new ESP32-S3 project in the workspace from the bundled hello_world template " +
      "(LED blink + chip info logging, LED pin configurable via sdkconfig). " +
      "Run esp32_env_check first; build requires a ready ESP-IDF v5.5 environment.",
    inputSchema: {
      name: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "项目名只能包含字母、数字、点、下划线、连字符")
        .describe("Project directory name, created under the workspace root"),
      target: TargetArg,
    },
    _meta: MODEL_AND_APP,
  },
  async ({ name }) => {
    const dest = join(workspaceRoot, name);
    if (existsSync(dest)) {
      throw new Error(`目录已存在：${dest}；换个项目名或删除后重试。`);
    }
    const templateDir = join(DIST_DIR, "templates", "hello_world");
    if (!existsSync(templateDir)) {
      throw new Error(`模板缺失（${templateDir}）；安装产物不完整，请重装插件。`);
    }
    // 整树复制模板：模板新增文件（如 Kconfig.projbuild）不需要改这份清单。
    const { cp, readFile: readFileText, writeFile: writeFileText } = await import("node:fs/promises");
    await cp(templateDir, dest, { recursive: true });
    // 产物名跟随目录名：把 CMake project() 重写为实际项目名，避免 bin 名与目录名不一致。
    const cmake = join(dest, "CMakeLists.txt");
    await writeFileText(
      cmake,
      (await readFileText(cmake, "utf8")).replace(/^project\(.+\)\s*$/m, `project(${name})`),
    );
    return {
      content: [
        {
          type: "text",
          text: `项目已创建：${dest}。下一步：esp32_set_target（首次配置 target），然后 esp32_build。`,
        },
      ],
      structuredContent: { projectDir: dest, template: "hello_world", next: ["esp32_set_target", "esp32_build"] },
    };
  },
);

server.registerTool(
  "esp32_list_projects",
  {
    title: "List ESP32 projects in the workspace",
    description:
      "List ESP-IDF projects under the workspace root (directories containing CMakeLists.txt), " +
      "up to two levels deep. Use it to pick a project for set-target/build/flash. " +
      "Pass root to scan a local folder chosen in the panel browser; defaults to the session workspace.",
    inputSchema: {
      root: z.string().optional().describe("Folder to scan (absolute path); defaults to the session workspace"),
    },
    _meta: { ui: { visibility: ["app"] } },
  },
  async ({ root }) => {
    const SKIP = new Set(["build", "log", "node_modules", "dist", "managed_components", "dependencies.lock"]);
    const base = root?.trim() || workspaceRoot;
    if (!existsSync(base)) throw new Error(`扫描根目录不存在：${base}`);
    const projects: string[] = [];
    async function scan(dir: string, depth: number): Promise<void> {
      if (existsSync(join(dir, "CMakeLists.txt"))) {
        projects.push(dir);
        return;
      }
      if (depth <= 0) return;
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
        await scan(join(dir, entry.name), depth - 1);
      }
    }
    await scan(base, 2);
    projects.sort();
    return {
      content: [{ type: "text", text: `在 ${base} 下发现 ${projects.length} 个项目。` }],
      structuredContent: { root: base, workspaceRoot, projects },
    };
  },
);

server.registerTool(
  "esp32_list_dir",
  {
    title: "Browse local folders",
    description:
      "List subdirectories of a local folder for the panel's project-folder browser. " +
      "Read-only; hidden and build directories are skipped. Defaults to the session workspace.",
    inputSchema: {
      path: z.string().optional().describe("Folder to list; defaults to the session workspace"),
    },
    _meta: { ui: { visibility: ["app"] } },
  },
  async ({ path: raw }) => {
    const dir = raw?.trim() || workspaceRoot;
    if (!existsSync(dir)) throw new Error(`目录不存在：${dir}`);
    const entries = await readdir(dir, { withFileTypes: true });
    const directories = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
    const parent = dirname(dir);
    return {
      content: [{ type: "text", text: `${dir}：${directories.length} 个子目录` }],
      structuredContent: { path: dir, parent: parent === dir ? null : parent, directories },
    };
  },
);

server.registerTool(
  "esp32_set_target",
  {
    title: "Set project target chip",
    description:
      "Run `idf.py set-target esp32s3` on a project. Required once per project before the first build; " +
      "regenerates sdkconfig for the target. Requires a ready ESP-IDF v5.5 environment (see esp32_env_check).",
    inputSchema: {
      project: z.string().describe("Project directory (workspace-relative name or absolute path)"),
      target: TargetArg,
    },
    _meta: { ...MODEL_AND_APP, ...JOB_CARD_META },
  },
  async ({ project, target }) => {
    const { idfPath } = await requireIdf();
    const dir = resolveProjectDir(project);
    const meta = await startJob({
      dataDir,
      kind: "set-target",
      title: `set-target ${target}`,
      command: idfJobCommand(dir, `set-target ${target}`),
      cwd: dir,
      env: { ...idfEnv(resolveToolsPath(process.env, dataDir, idfPath)), IDF_PATH: idfPath },
      context: { project: dir },
    });
    return {
      content: [{ type: "text", text: `set-target 作业已启动。${jobRef(meta).logHint}` }],
      structuredContent: { ...jobRef(meta), project: dir },
    };
  },
);

server.registerTool(
  "esp32_sdkconfig_get",
  {
    title: "Read project sdkconfig options",
    description:
      "Read resolved Kconfig options from a project's build/config/sdkconfig.json (exists after set-target or build). " +
      "Keys are returned in IDF 5.x native form (no CONFIG_ prefix); the prefix filter accepts both styles, " +
      "e.g. CONFIG_ESPTOOLPY or ESPTOOLPY.",
    inputSchema: {
      project: z.string().describe("Project directory"),
      prefix: z.string().optional().describe("Option-name prefix filter, e.g. CONFIG_ESPTOOLPY or ESPTOOLPY"),
    },
    _meta: MODEL_AND_APP,
  },
  async ({ project, prefix }) => {
    const dir = resolveProjectDir(project);
    const file = join(dir, "build", "config", "sdkconfig.json");
    if (!existsSync(file)) {
      throw new Error(`未找到 ${file}；先执行 esp32_set_target 或 esp32_build 生成配置。`);
    }
    const options = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    // IDF 5.x 的 sdkconfig.json 键不带 CONFIG_ 前缀；前缀过滤两种写法都接受。
    const normalized = prefix?.replace(/^CONFIG_/, "") ?? "";
    const filtered = Object.fromEntries(
      Object.entries(options).filter(([key]) => !normalized || key.startsWith(normalized)),
    );
    const count = Object.keys(filtered).length;
    return {
      content: [{ type: "text", text: `${count} 项配置（prefix=${prefix ?? "*"}）。` }],
      structuredContent: { project: dir, count, options: filtered },
    };
  },
);

server.registerTool(
  "esp32_sdkconfig_set",
  {
    title: "Set project sdkconfig options",
    description:
      "Set Kconfig options for a project: entries are written to sdkconfig.defaults (durable) and patched " +
      "into the active sdkconfig when present, so the next build picks them up. " +
      "Example: { \"CONFIG_BLINK_GPIO\": \"48\" }.",
    inputSchema: {
      project: z.string().describe("Project directory"),
      entries: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).describe("Option name to value"),
    },
    _meta: MODEL_AND_APP,
  },
  async ({ project, entries }) => {
    const dir = resolveProjectDir(project);
    // sdkconfig.defaults / sdkconfig 文本格式要求 CONFIG_ 前缀；两种键名写法都归一化。
    const lines = Object.entries(entries).map(
      ([key, value]) => `${key.startsWith("CONFIG_") ? key : `CONFIG_${key}`}=${formatKconfigValue(value)}`,
    );
    const defaultsPath = join(dir, "sdkconfig.defaults");
    const defaults = existsSync(defaultsPath) ? await readFile(defaultsPath, "utf8") : "";
    const merged = mergeKconfig(defaults, lines);
    await writeFileText(defaultsPath, merged);
    const activePath = join(dir, "sdkconfig");
    let patchedActive = false;
    if (existsSync(activePath)) {
      await writeFileText(activePath, mergeKconfig(await readFile(activePath, "utf8"), lines));
      patchedActive = true;
    }
    return {
      content: [
        {
          type: "text",
          text: `已写入 ${lines.length} 项到 sdkconfig.defaults${patchedActive ? " 并补丁到 sdkconfig" : ""}；下次 esp32_build 生效。`,
        },
      ],
      structuredContent: { project: dir, applied: lines, patchedActive },
    };
  },
);

/* ---------------------------------- 管线（M1） ---------------------------------- */

server.registerTool(
  "esp32_build",
  {
    title: "Build an ESP32-S3 project",
    description:
      "Build an ESP32-S3 project with `idf.py build` as a background job; returns a jobId immediately. " +
      "Track progress with esp32_job_logs / esp32_job_status. Requires a ready ESP-IDF v5.5 environment.",
    inputSchema: { project: z.string().describe("Project directory") },
    _meta: { ...MODEL_AND_APP, ...JOB_CARD_META },
  },
  async ({ project }) => {
    const { idfPath } = await requireIdf();
    const dir = resolveProjectDir(project);
    const meta = await startJob({
      dataDir,
      kind: "build",
      title: `idf.py build (${project})`,
      command: idfJobCommand(dir, "build"),
      cwd: dir,
      env: { ...idfEnv(resolveToolsPath(process.env, dataDir, idfPath)), IDF_PATH: idfPath },
      context: { project: dir },
    });
    return {
      content: [{ type: "text", text: `编译作业已启动（首次编译需数分钟）。${jobRef(meta).logHint}` }],
      structuredContent: { ...jobRef(meta), project: dir },
    };
  },
);

server.registerTool(
  "esp32_flash",
  {
    title: "Flash firmware to the device",
    description:
      "Flash the built firmware over serial with `idf.py flash` as a background job. " +
      "SIDE EFFECT: overwrites the flash of the connected board. " +
      "Pass a port or let the plugin pick the first detected serial port.",
    inputSchema: {
      project: z.string().describe("Project directory"),
      port: z.string().optional().describe("Serial port, e.g. /dev/tty.usbmodem*; auto-detected when omitted"),
    },
    _meta: { ...MODEL_AND_APP, ...JOB_CARD_META },
  },
  async ({ project, port }) => {
    const { idfPath } = await requireIdf();
    const dir = resolveProjectDir(project);
    const target = port?.trim() || (await listSerialPorts())[0];
    if (!target) throw new Error("未检测到串口设备；接上开发板后用 esp32_env_check 重新检查。");
    const meta = await startJob({
      dataDir,
      kind: "flash",
      title: `idf.py flash → ${target}`,
      command: idfJobCommand(dir, `-p ${shellQuote(target)} flash`),
      cwd: dir,
      env: { ...idfEnv(resolveToolsPath(process.env, dataDir, idfPath)), IDF_PATH: idfPath },
      context: { project: dir, port: target },
    });
    return {
      content: [{ type: "text", text: `烧录作业已启动（目标 ${target}，将覆写设备 flash）。${jobRef(meta).logHint}` }],
      structuredContent: { ...jobRef(meta), project: dir, port: target },
    };
  },
);

server.registerTool(
  "esp32_size",
  {
    title: "Show firmware size breakdown",
    description:
      "Run `idf.py size` for a built project as a short background job and return the partition/memory usage table.",
    inputSchema: { project: z.string().describe("Project directory") },
    _meta: MODEL_AND_APP,
  },
  async ({ project }) => {
    const { idfPath } = await requireIdf();
    const dir = resolveProjectDir(project);
    const meta = await startJob({
      dataDir,
      kind: "size",
      title: `idf.py size (${project})`,
      command: idfJobCommand(dir, "size"),
      cwd: dir,
      env: { ...idfEnv(resolveToolsPath(process.env, dataDir, idfPath)), IDF_PATH: idfPath },
      context: { project: dir },
    });
    return {
      content: [{ type: "text", text: `size 作业已启动。${jobRef(meta).logHint}` }],
      structuredContent: { ...jobRef(meta), project: dir },
    };
  },
);

server.registerTool(
  "esp32_detect_devices",
  {
    title: "Identify the connected chip over serial",
    description:
      "Probe serial port(s) with esptool chip_id to read live chip info (model, revision, MAC, flash size). " +
      "SIDE EFFECT: esptool resets the target chip during probing. Requires a ready ESP-IDF environment.",
    inputSchema: { port: z.string().optional().describe("Serial port; probes all detected ports when omitted") },
    _meta: MODEL_AND_APP,
  },
  async ({ port }) => {
    const { idfPython } = await requireIdf();
    if (!idfPython) {
      throw new Error("未找到 IDF python 环境（esptool 所在）；请先 esp32_env_check 并完成 ESP-IDF 安装。");
    }
    const ports = port?.trim() ? [port.trim()] : await listSerialPorts();
    if (ports.length === 0) throw new Error("未检测到串口设备；接上开发板后重试。");
    const results = [];
    for (const target of ports) {
      const probe = await runCapture(
        `${shellQuote(idfPython)} -m esptool --port ${shellQuote(target)} --baud 115200 chip_id`,
        { timeoutMs: 25000 },
      );
      const output = stripAnsi(probe.output);
      const chip = /Chip is ([^\r\n(]+)/.exec(output)?.[1]?.trim() ?? null;
      const mac = /MAC: ([0-9a-f:]+)/i.exec(output)?.[1] ?? null;
      const flash = /Detected flash size: ([^\r\n]+)/.exec(output)?.[1]?.trim() ?? null;
      results.push({ port: target, ok: probe.ok, chip, mac, flash, output: output.slice(-4000) });
    }
    const found = results.filter((r) => r.ok && r.chip);
    return {
      content: [
        {
          type: "text",
          text: found.length
            ? `识别到 ${found.length} 个设备：${found.map((r) => `${r.port} = ${r.chip}`).join("；")}。注意探测会复位目标芯片。`
            : `未识别到 ESP32 设备；原始输出见 structuredContent（探测会复位芯片）。`,
        },
      ],
      structuredContent: { devices: results },
    };
  },
);

/* ---------------------------------- 作业（M1） ---------------------------------- */

server.registerTool(
  "esp32_job_status",
  {
    title: "Query job status",
    description: "Query the status of a background job (build/flash/monitor/install): running/succeeded/failed/cancelled/interrupted plus exit code.",
    inputSchema: { jobId: z.string().describe("Job id returned by the starting tool") },
    _meta: MODEL_AND_APP,
  },
  async ({ jobId }) => {
    const meta = await readJobMeta(dataDir, jobId);
    return {
      content: [{ type: "text", text: `${meta.kind} ${meta.id}: ${meta.status}${meta.exitCode != null ? ` (exit ${meta.exitCode})` : ""}` }],
      structuredContent: { job: meta },
    };
  },
);

server.registerTool(
  "esp32_job_logs",
  {
    title: "Read job log tail",
    description:
      "Incrementally read a job's log from a byte cursor (pass back the cursor from the previous call). " +
      "Default chunk is 32 KiB; output is ANSI-stripped text.",
    inputSchema: {
      jobId: z.string().describe("Job id"),
      cursor: z.number().optional().describe("Byte offset from the previous call (0 for first read)"),
      maxBytes: z.number().optional().describe("Max bytes to return (default 32768)"),
    },
    _meta: MODEL_AND_APP,
  },
  async ({ jobId, cursor, maxBytes }) => {
    const chunk = await readJobLogs(dataDir, jobId, cursor ?? 0, maxBytes ?? 32 * 1024);
    return {
      content: [
        {
          type: "text",
          text: chunk.text
            ? `[${chunk.status}] ${chunk.text}`
            : `[${chunk.status}] 暂无新输出（cursor=${chunk.cursor}/${chunk.size}）。`,
        },
      ],
      structuredContent: chunk,
    };
  },
);

server.registerTool(
  "esp32_job_cancel",
  {
    title: "Cancel a running job",
    description: "Cancel a running job (SIGTERM the process group, SIGKILL after 3s).",
    inputSchema: { jobId: z.string().describe("Job id") },
    _meta: MODEL_AND_APP,
  },
  async ({ jobId }) => {
    const meta = await cancelJob(dataDir, jobId);
    return {
      content: [{ type: "text", text: `作业 ${jobId} 已请求取消（当前状态 ${meta.status}）。` }],
      structuredContent: { job: meta },
    };
  },
);

/* ---------------------------------- 串口监视（M1） ---------------------------------- */

server.registerTool(
  "esp32_monitor_start",
  {
    title: "Start the serial monitor",
    description:
      "Start reading a serial port in the background (pyserial helper from the IDF python environment); " +
      "raw bytes are appended to the job log. Read incrementally with esp32_monitor_read " +
      "(pass ansi:true to keep raw color codes for UI rendering). " +
      "With logToFile:true, timestamped lines are also written to <workspace>/log/session_<port>_<timestamp>.log. " +
      "One port can only be monitored by one job at a time.",
    inputSchema: {
      port: z.string().describe("Serial port, e.g. /dev/tty.usbmodem*"),
      baud: z.number().optional().describe("Baud rate (default 115200)"),
      logToFile: z
        .boolean()
        .optional()
        .describe("Also write timestamped lines to <workspace>/log/session_<port>_<timestamp>.log"),
    },
    _meta: MODEL_AND_APP,
  },
  async ({ port, baud, logToFile }) => {
    const { idfPython } = await requireIdf();
    if (!idfPython) {
      throw new Error("串口监视需要 IDF python 环境（pyserial）；请先 esp32_env_check 并完成安装。");
    }
    const target = port.trim();
    if (serialLock.has(target)) {
      throw new Error(`串口 ${target} 正被作业 ${serialLock.get(target)} 占用；先 esp32_monitor_stop。`);
    }
    const helper = join(DIST_DIR, "serial-helper.py");
    if (!existsSync(helper)) throw new Error("安装产物缺少 serial-helper.py；请重装插件。");
    let logfile: string | undefined;
    if (logToFile) {
      const portShort = basename(target).replace(/[^A-Za-z0-9._-]/g, "_");
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const stamp =
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
        `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const dir = join(workspaceRoot, "log");
      await mkdir(dir, { recursive: true });
      logfile = join(dir, `session_${portShort}_${stamp}.log`);
    }
    const meta = await startJob({
      dataDir,
      kind: "monitor",
      stdinPipe: true,
      title: `serial monitor → ${target}`,
      command: (jobDir) =>
        `${shellQuote(idfPython)} ${shellQuote(helper)} --port ${shellQuote(target)} --baud ${baud ?? 115200} ` +
        `--log ${shellQuote(join(jobDir, "log"))}` +
        (logfile ? ` --logfile ${shellQuote(logfile)}` : ""),
      context: { port: target, ...(logfile ? { logfile } : {}) },
      onExit: () => {
        if (serialLock.get(target) === meta.id) serialLock.delete(target);
      },
    });
    serialLock.set(target, meta.id);
    return {
      content: [
        {
          type: "text",
          text:
            `串口监视已启动（${target}@${baud ?? 115200}）。` +
            (logfile ? `日志落盘：${logfile}。` : "") +
            ` 用 esp32_monitor_read { jobId: "${meta.id}" } 增量读取。`,
        },
      ],
      structuredContent: {
        ...jobRef(meta),
        port: target,
        baud: baud ?? 115200,
        ...(logfile ? { logfile } : {}),
      },
    };
  },
);

server.registerTool(
  "esp32_monitor_read",
  {
    title: "Read monitor output",
    description:
      "Incrementally read the monitor job's serial output from a byte cursor. " +
      "Pass ansi:true to keep raw ANSI color codes (for terminal-style UI rendering); " +
      "default output is ANSI-stripped plain text.",
    inputSchema: {
      jobId: z.string().describe("Monitor job id"),
      cursor: z.number().optional().describe("Byte offset from the previous call (0 for first read)"),
      maxBytes: z.number().optional().describe("Max bytes to return (default 32768)"),
      ansi: z.boolean().optional().describe("Keep raw ANSI color codes (default false)"),
    },
    _meta: MODEL_AND_APP,
  },
  async ({ jobId, cursor, maxBytes, ansi }) => {
    const meta = await readJobMeta(dataDir, jobId);
    if (meta.kind !== "monitor") throw new Error(`${jobId} 不是监视作业；读取日志请用 esp32_job_logs。`);
    const chunk = await readJobLogs(dataDir, jobId, cursor ?? 0, maxBytes ?? 32 * 1024, ansi ?? false);
    return {
      content: [{ type: "text", text: chunk.text ? `[${chunk.status}] ${chunk.text}` : `[${chunk.status}] 暂无新输出。` }],
      structuredContent: chunk,
    };
  },
);

server.registerTool(
  "esp32_monitor_log_toggle",
  {
    title: "Toggle monitor log file",
    description:
      "Turn the monitor's timestamped session log on/off immediately while monitoring. " +
      "Turning it on creates a NEW log file (<workspace>/log/session_<port>_<timestamp>.log); " +
      "stopping the monitor always closes the current file.",
    inputSchema: {
      jobId: z.string().describe("Monitor job id"),
      enabled: z.boolean().describe("true to open a new log file now, false to close it"),
    },
    _meta: MODEL_AND_APP,
  },
  async ({ jobId, enabled }) => {
    const meta = await readJobMeta(dataDir, jobId);
    if (meta.kind !== "monitor" || meta.status !== "running") {
      throw new Error(`监视作业 ${jobId} 不在运行（${meta.status}）。`);
    }
    const stdin = getJobChild(jobId)?.stdin;
    if (!stdin || stdin.destroyed) {
      throw new Error("无法连接监视进程；请重新 esp32_monitor_start。");
    }
    if (!enabled) {
      stdin.write(JSON.stringify({ cmd: "logoff" }) + "\n");
      await patchJobMeta(dataDir, jobId, { context: { ...(meta.context ?? {}), logfile: "" } });
      return {
        content: [{ type: "text", text: "日志落盘已关闭。" }],
        structuredContent: { jobId, enabled: false, logfile: null },
      };
    }
    const port = meta.context?.port ?? "unknown";
    const portShort = basename(port).replace(/[^A-Za-z0-9._-]/g, "_");
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const dir = join(workspaceRoot, "log");
    await mkdir(dir, { recursive: true });
    const logfile = join(dir, `session_${portShort}_${stamp}.log`);
    stdin.write(JSON.stringify({ cmd: "logon", logfile }) + "\n");
    await patchJobMeta(dataDir, jobId, { context: { ...(meta.context ?? {}), logfile } });
    return {
      content: [{ type: "text", text: `日志落盘已开启：${logfile}` }],
      structuredContent: { jobId, enabled: true, logfile },
    };
  },
);

server.registerTool(
  "esp32_monitor_send",
  {
    title: "Send input to the device",
    description:
      "Write one line of input to a monitored serial port. Routed through the resident monitor " +
      "process's stdin — the port is NOT reopened, so boards whose USB-UART bridge resets on " +
      "control-line changes (e.g. ESP32-S3 built-in USB-Serial-JTAG) keep running.",
    inputSchema: {
      jobId: z.string().describe("Monitor job id holding the port"),
      text: z.string().describe("Text to send"),
      newline: z.boolean().optional().describe("Append a newline (default true)"),
    },
    _meta: MODEL_AND_APP,
  },
  async ({ jobId, text, newline }) => {
    const meta = await readJobMeta(dataDir, jobId);
    if (meta.kind !== "monitor" || meta.status !== "running") {
      throw new Error(`监视作业 ${jobId} 不在运行（${meta.status}）。`);
    }
    const stdin = getJobChild(jobId)?.stdin;
    if (!stdin || stdin.destroyed) {
      throw new Error(
        "无法连接监视进程的发送通道（服务可能重启过）；请 esp32_monitor_stop 后重新 esp32_monitor_start。",
      );
    }
    // 解释命令文本里的字面转义（用户习惯输入 version\r\n 之类），避免当普通字符发给设备
    const interpreted = text.replace(/\\r/g, "\r").replace(/\\n/g, "\n");
    await new Promise<void>((resolve, reject) => {
      stdin.write(JSON.stringify({ text: interpreted, newline: newline ?? true }) + "\n", (error) =>
        error ? reject(error) : resolve(),
      );
    });
    return {
      content: [{ type: "text", text: `已发送 ${text.length} 字符到 ${meta.context?.port ?? "?"}（未重开端口）。` }],
      structuredContent: { jobId, port: meta.context?.port, ok: true },
    };
  },
);

server.registerTool(
  "esp32_monitor_stop",
  {
    title: "Stop the serial monitor",
    description: "Stop a monitor job and release the serial port.",
    inputSchema: { jobId: z.string().describe("Monitor job id") },
    _meta: MODEL_AND_APP,
  },
  async ({ jobId }) => {
    const meta = await cancelJob(dataDir, jobId);
    const port = meta.context?.port;
    if (port && serialLock.get(port) === jobId) serialLock.delete(port);
    return {
      content: [{ type: "text", text: `监视作业 ${jobId} 已停止，串口 ${port ?? "?"} 已释放。` }],
      structuredContent: { job: meta },
    };
  },
);

/* ------------------------- UART 命令（面板自定义，仅页面） ------------------------- */

interface UartCommand {
  label: string;
  text: string;
  newline: boolean;
  group?: string;
}

const UART_COMMANDS_DEFAULT: UartCommand[] = [
  { label: "version", text: "version", newline: true, group: "常用" },
  { label: "status", text: "status", newline: true, group: "常用" },
  { label: "reboot", text: "reboot", newline: true, group: "常用" },
];

function uartCommandsFile(): string {
  return join(dataDir, "uart-commands.json");
}

const UartCommandSchema = z.object({
  label: z.string().min(1).max(64).describe("按钮显示名"),
  text: z.string().min(1).max(512).describe("发送到串口的文本"),
  newline: z.boolean().optional().describe("末尾追加换行（默认 true）"),
  group: z.string().max(32).optional().describe("分组名（可选，默认归入“命令”）"),
  danger: z.boolean().optional().describe("危险操作：点击时需要面板弹窗确认"),
});

server.registerTool(
  "esp32_uart_commands_get",
  {
    title: "List custom UART commands",
    description:
      "List the panel's custom UART command buttons (persisted in the plugin data directory). " +
      "Returns the built-in defaults when nothing has been customized.",
    inputSchema: {},
    _meta: { ui: { visibility: ["app"] } },
  },
  async () => {
    let commands = UART_COMMANDS_DEFAULT;
    if (existsSync(uartCommandsFile())) {
      try {
        const parsed = JSON.parse(await readFile(uartCommandsFile(), "utf8")) as UartCommand[];
        if (Array.isArray(parsed) && parsed.length > 0) commands = parsed;
      } catch {
        // 损坏文件回退默认值
      }
    }
    return {
      content: [{ type: "text", text: `${commands.length} 条自定义 UART 命令。` }],
      structuredContent: { commands },
    };
  },
);

server.registerTool(
  "esp32_uart_commands_set",
  {
    title: "Save custom UART commands",
    description:
      "Replace the panel's custom UART command buttons (persisted in the plugin data directory, " +
      "so they survive sessions and restarts). Pass the full list; 100 entries max.",
    inputSchema: {
      commands: z.array(UartCommandSchema).max(100).describe("Full command list"),
    },
    _meta: { ui: { visibility: ["app"] } },
  },
  async ({ commands }) => {
    const normalized = commands.map((c) => ({
      label: c.label,
      text: c.text,
      newline: c.newline ?? true,
      ...(c.group ? { group: c.group } : {}),
      ...(c.danger ? { danger: true } : {}),
    }));
    await writeFileText(uartCommandsFile(), JSON.stringify(normalized, null, 2) + "\n");
    return {
      content: [{ type: "text", text: `已保存 ${normalized.length} 条自定义 UART 命令。` }],
      structuredContent: { commands: normalized },
    };
  },
);

/* ---------------------------------- UI 资源（M2） ---------------------------------- */

server.registerResource(
  "panel",
  PANEL_URI,
  { mimeType: HTML_MIME, description: "ESP32 AI Builder panel: chip library, build pipeline, serial monitor" },
  async () => ({
    contents: [{ uri: PANEL_URI, mimeType: HTML_MIME, text: await readPage("panel.html", "__PANEL_CLIENT__") }],
  }),
);

server.registerResource(
  "card",
  CARD_URI,
  { mimeType: HTML_MIME, description: "Inline job progress card for build/flash results" },
  async () => ({
    contents: [{ uri: CARD_URI, mimeType: HTML_MIME, text: await readPage("card.html", "__CARD_CLIENT__") }],
  }),
);

async function readPage(file: string, placeholder: string): Promise<string> {
  const html = await readFile(join(DIST_DIR, "ui", file), "utf8");
  if (html.includes(placeholder)) {
    throw new Error(`Build esp32-ai-builder first and launch dist/server.mjs (pnpm build). Missing client: ${placeholder}`);
  }
  return html;
}

/* ---------------------------------- 启动 ---------------------------------- */

function formatKconfigValue(value: string | number | boolean): string {
  if (typeof value === "boolean") return value ? "y" : "n";
  return String(value);
}

function mergeKconfig(existing: string, lines: string[]): string {
  const keys = new Set(lines.map((line) => line.split("=", 1)[0]));
  const kept = existing
    .split("\n")
    .filter((line) => line.trim() && !keys.has(line.trim().split("=", 1)[0]));
  return [...kept, ...lines, ""].join("\n");
}

async function writeFileText(path: string, content: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, content, "utf8");
}

await server.connect(new StdioServerTransport());
await reapStaleJobs(dataDir).catch(() => undefined);
process.stderr.write("[esp32-ai-builder] MCP server ready\n");
