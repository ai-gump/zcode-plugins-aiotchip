// 长任务（作业）管理：build / flash / install / monitor 统一为后台进程 + 日志落盘。
// 作业状态以 ZCODE_PLUGIN_DATA/jobs/<id>/meta.json 为准，内存注册表只是缓存；
// 服务重启时把 pid 已死的 running 作业标记为 interrupted。
import type { ChildProcess } from "node:child_process";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type JobStatus = "running" | "succeeded" | "failed" | "cancelled" | "interrupted";

export interface JobMeta {
  [key: string]: unknown;
  id: string;
  kind: string;
  title: string;
  command: string;
  status: JobStatus;
  pid?: number;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  context?: Record<string, string>;
}

interface RunningJob {
  meta: JobMeta;
  dir: string;
  child?: ChildProcess;
  onExit?: (meta: JobMeta) => void;
}

const registry = new Map<string, RunningJob>();

export function jobsRoot(dataDir: string): string {
  return join(dataDir, "jobs");
}

function newJobId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** ANSI 转义清理，保证模型和面板读到纯文本日志。 */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "");
}

async function persist(dir: string, meta: JobMeta): Promise<void> {
  await writeFile(join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
}

export interface StartJobOptions {
  dataDir: string;
  kind: string;
  title: string;
  /** 固定命令串，或拿到作业目录后构造（监视作业把串口数据写进自己的目录）。 */
  command: string | ((jobDir: string) => string);
  cwd?: string;
  env?: Record<string, string>;
  context?: Record<string, string>;
  onExit?: (meta: JobMeta) => void;
}

/** 启动 bash -lc 作业（独立进程组，便于整组终止）；立即返回作业元数据。 */
export async function startJob(options: StartJobOptions): Promise<JobMeta> {
  const id = newJobId();
  const dir = join(jobsRoot(options.dataDir), id);
  await mkdir(dir, { recursive: true });
  const command =
    typeof options.command === "function" ? options.command(dir) : options.command;
  const meta: JobMeta = {
    id,
    kind: options.kind,
    title: options.title,
    command: typeof options.command === "function" ? "<constructed>" : options.command,
    status: "running",
    startedAt: new Date().toISOString(),
    context: options.context,
  };
  const entry: RunningJob = { meta, dir, onExit: options.onExit };
  registry.set(id, entry);
  await persist(dir, meta);

  const { spawn } = await import("node:child_process");
  const child = spawn("bash", ["-lc", command], {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  entry.child = child;
  meta.pid = child.pid;
  meta.command = command;
  await persist(dir, meta);

  const { createWriteStream } = await import("node:fs");
  const stream = createWriteStream(join(dir, "log"), { flags: "a" });
  child.stdout?.pipe(stream);
  child.stderr?.pipe(stream);
  void child.on("exit", (code, signal) => {
    const cancelled = entry.meta.status === "cancelled";
    entry.meta.status = cancelled ? "cancelled" : code === 0 ? "succeeded" : "failed";
    entry.meta.exitCode = code;
    entry.meta.endedAt = new Date().toISOString();
    stream.end();
    void persist(dir, entry.meta);
    registry.delete(id);
    entry.onExit?.(entry.meta);
    void signal; // 记录在日志之外仅用于调试，不进 meta
  });
  return meta;
}

export async function jobDir(dataDir: string, jobId: string): Promise<string> {
  const dir = join(jobsRoot(dataDir), jobId);
  if (!existsSync(join(dir, "meta.json"))) {
    throw new Error(`Unknown job: ${jobId}`);
  }
  return dir;
}

export async function readJobMeta(dataDir: string, jobId: string): Promise<JobMeta> {
  const dir = await jobDir(dataDir, jobId);
  const cached = registry.get(jobId)?.meta;
  if (cached) return cached;
  return JSON.parse(await readFile(join(dir, "meta.json"), "utf8")) as JobMeta;
}

export interface JobLogChunk {
  [key: string]: unknown;
  cursor: number;
  size: number;
  text: string;
  status: JobStatus;
}

/** 从字节游标增量读取日志；默认每片 32 KiB，返回新游标。 */
export async function readJobLogs(
  dataDir: string,
  jobId: string,
  cursor = 0,
  maxBytes = 32 * 1024,
): Promise<JobLogChunk> {
  const dir = await jobDir(dataDir, jobId);
  const meta = await readJobMeta(dataDir, jobId);
  const { open } = await import("node:fs/promises");
  const handle = await open(join(dir, "log"), "a+");
  try {
    const size = (await handle.stat()).size;
    const start = Math.min(cursor, size);
    const length = Math.min(maxBytes, size - start);
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, start);
    return { cursor: start + length, size, text: stripAnsi(buffer.toString("utf8")), status: meta.status };
  } finally {
    await handle.close();
  }
}

/** SIGTERM 整个进程组，3 秒后仍存活则 SIGKILL。 */
export async function cancelJob(dataDir: string, jobId: string): Promise<JobMeta> {
  const meta = await readJobMeta(dataDir, jobId);
  if (meta.status !== "running") return meta;
  const entry = registry.get(jobId);
  if (!entry?.child?.pid) throw new Error(`Job ${jobId} is registered as running but has no live process; cannot cancel.`);
  entry.meta.status = "cancelled";
  await persist(entry.dir, entry.meta);
  const pid = entry.child.pid;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // 进程可能刚好退出
  }
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // 已退出
    }
  }, 3000).unref();
  return entry.meta;
}

/** 服务启动时调用：孤儿 running 作业标记为 interrupted（pid 已死）。 */
export async function reapStaleJobs(dataDir: string): Promise<number> {
  const root = jobsRoot(dataDir);
  if (!existsSync(root)) return 0;
  let reaped = 0;
  for (const id of await readdir(root)) {
    const metaPath = join(root, id, "meta.json");
    if (!existsSync(metaPath)) continue;
    const meta = JSON.parse(await readFile(metaPath, "utf8")) as JobMeta;
    if (meta.status !== "running") continue;
    if (registry.has(id)) continue;
    const alive = meta.pid
      ? await new Promise<boolean>((resolve) => {
          try {
            process.kill(meta.pid as number, 0);
            resolve(true);
          } catch {
            resolve(false);
          }
        })
      : false;
    if (!alive) {
      meta.status = "interrupted";
      meta.endedAt = new Date().toISOString();
      await writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n");
      reaped += 1;
    }
  }
  return reaped;
}
