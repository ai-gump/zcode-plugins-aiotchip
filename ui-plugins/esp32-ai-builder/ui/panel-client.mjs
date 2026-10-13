// ESP32 AI 开发台面板客户端（MCP Apps）。先注册事件再 connect()；能力协商决定可选功能。
import { App } from "@modelcontextprotocol/ext-apps";

const app = new App(
  { name: "esp32-ai-builder-panel", version: "0.4.5" },
  { availableDisplayModes: ["inline", "fullscreen"] },
);

const $ = (id) => document.getElementById(id);
let monitorJob = null;
let monitorCursor = 0;
let job = null;
let jobCursor = 0;
let pollTimer = null;

function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 2600);
}

function applyTheme() {
  const theme = app.getHostContext()?.theme === "dark" ? "dark" : "light";
  document.body.dataset.theme = theme;
}
app.onhostcontextchanged = applyTheme;

async function call(name, args) {
  const result = await app.callServerTool({ name, arguments: args ?? {} });
  if (result.isError) {
    const text = (result.content ?? []).find((c) => c.type === "text")?.text ?? "调用失败";
    throw new Error(text);
  }
  return result.structuredContent ?? {};
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    pollJob();
    pollMonitor();
  }, 1000);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

/* ---------- 芯片库 ---------- */

async function loadChip() {
  try {
    const data = await call("esp32_chip_info", { target: "esp32s3" });
    const spec = data.spec;
    $("chip-name").textContent = `${spec.displayName}（ESP-IDF v${data.pinnedIdfVersion}）`;
    $("chip-summary").textContent = spec.summary;
    const rows = [
      ["CPU", spec.cpu], ["SRAM", spec.sram], ["ROM", spec.rom],
      ["PSRAM", spec.psram], ["Flash", spec.flash], ["无线", spec.wireless.join("；")],
      ["GPIO", `${spec.gpioCount} 个`], ["USB", spec.usb], ["JTAG", spec.jtag],
      ["常见开发板", spec.devkits.join("、")],
    ];
    $("chip-spec").innerHTML = rows
      .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`)
      .join("");
    $("chip-highlights").innerHTML = spec.highlights.map((h) => `<li>${h}</li>`).join("");
    $("chip-docs").innerHTML = spec.docs
      .map((d) => `<li><a href="#" data-url="${d.url}">${d.label}</a></li>`)
      .join("");
    for (const a of $("chip-docs").querySelectorAll("a")) {
      a.onclick = (event) => {
        event.preventDefault();
        app.openLink({ url: a.dataset.url });
      };
    }
    $("chip-loading").hidden = true;
    $("chip-body").hidden = false;
  } catch (error) {
    $("chip-loading").textContent = `芯片资料加载失败：${error.message}`;
  }
}

$("chip-context").onclick = async () => {
  try {
    await app.updateModelContext({
      content: [
        {
          type: "text",
          text: "用户在 ESP32 AI 开发台面板中查看了 ESP32-S3 选型信息（双核 LX7 240MHz、512KB SRAM、内置 USB-Serial-JTAG、AI 向量指令），希望围绕 ESP32-S3 继续讨论。",
        },
      ],
    });
    toast("已添加到输入区上下文，可继续提问");
  } catch (error) {
    toast(`当前宿主不支持：${error.message}`);
  }
};

/* ---------- 构建管线 ---------- */

function portsToSelect(select, ports, current) {
  select.innerHTML = (ports.length ? ports : ["（未检测到串口）"])
    .map((p) => `<option value="${p}">${p}</option>`)
    .join("");
  if (current && ports.includes(current)) select.value = current;
}

let refreshInFlight = false;

/** 拉取环境并刷新两个串口下拉（保持当前选中值）。点击下拉即刻触发，不做定时自动刷新。 */
async function refreshEnv() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  const currentPort = $("port").value;
  const currentMonitor = $("monitor-port").value;
  try {
    const env = await call("esp32_env_check", {});
    const idf = env.idf;
    $("env-line").textContent = env.ready
      ? `环境就绪：ESP-IDF ${idf.version} @ ${idf.path}`
      : `环境未就绪：${(env.suggestions ?? []).join(" ")}`;
    portsToSelect($("port"), env.serialPorts ?? [], currentPort);
    portsToSelect($("monitor-port"), env.serialPorts ?? [], currentMonitor);
  } catch (error) {
    $("env-line").textContent = `环境检查失败：${error.message}`;
  } finally {
    refreshInFlight = false;
  }
}

let workspaceProjects = [];
let scanRoot = null; // null = 当前会话工作区
let sessionWorkspace = null;

async function loadProjects() {
  try {
    const data = await call("esp32_list_projects", scanRoot ? { root: scanRoot } : {});
    workspaceProjects = data.projects ?? [];
    sessionWorkspace = data.workspaceRoot ?? sessionWorkspace;
  } catch {
    workspaceProjects = [];
  }
  $("scan-root").textContent = `扫描位置：${scanRoot ?? sessionWorkspace ?? "当前会话工作区"}`;
  $("project-options").innerHTML = workspaceProjects
    .map((p) => `<option value="${p}"></option>`)
    .join("");
  $("project-options").innerHTML = workspaceProjects
    .map((p) => `<option value="${p}"></option>`)
    .join("");
  if (!$("project").value.trim()) {
    let saved = null;
    try {
      saved = localStorage.getItem("esp32.lastProject");
    } catch {}
    const match = saved && workspaceProjects.find((p) => p === saved || p.endsWith(`/${saved}`));
    if (match) $("project").value = match;
    else if (workspaceProjects.length === 1) $("project").value = workspaceProjects[0];
  }
}

/* ---------- 文件夹浏览器（沙箱内自绘，宿主不允许原生目录选择框） ---------- */

let dirNavPath = null;

async function openDirModal() {
  dirNavPath = scanRoot || sessionWorkspace;
  $("dir-modal").hidden = false;
  await renderDir(dirNavPath);
}

async function renderDir(path) {
  await guard(async () => {
    const data = await call("esp32_list_dir", { path });
    dirNavPath = data.path;
    $("dir-path").value = data.path;
    const list = $("dir-list");
    list.innerHTML = data.directories.length
      ? ""
      : '<div class="muted" style="padding: 6px 10px">（无子目录）</div>';
    for (const name of data.directories) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dir-item";
      btn.textContent = `📁 ${name}`;
      btn.onclick = () => renderDir(data.path.endsWith("/") ? data.path + name : `${data.path}/${name}`);
      list.appendChild(btn);
    }
  });
}

$("btn-browse").onclick = openDirModal;
$("dir-go").onclick = () => renderDir($("dir-path").value.trim());
$("dir-up").onclick = () => {
  if (dirNavPath) renderDir(dirNavPath);
};
$("dir-home").onclick = () => renderDir(sessionWorkspace ?? "");
$("dir-cancel").onclick = () => ($("dir-modal").hidden = true);
$("dir-ok").onclick = () =>
  guard(async () => {
    scanRoot = dirNavPath;
    $("dir-modal").hidden = true;
    await loadProjects();
  });

function currentProject() {
  const value = $("project").value.trim();
  if (value) return value;
  if (workspaceProjects.length === 1) return workspaceProjects[0];
  throw new Error(
    workspaceProjects.length
      ? `工作区发现 ${workspaceProjects.length} 个项目，请在“项目目录”里选择一个`
      : "工作区未发现 ESP32 项目（含 CMakeLists.txt 的目录）；可先创建项目",
  );
}

function rememberProject(project) {
  try {
    localStorage.setItem("esp32.lastProject", project);
  } catch {}
}

async function startJobTool(name, args, title) {
  const data = await call(name, args);
  job = { id: data.jobId, status: "running" };
  jobCursor = 0;
  $("job-head").hidden = false;
  $("job-log").hidden = false;
  $("job-head").textContent = `${title} · 作业 ${data.jobId}`;
  $("job-log").textContent = "";
  toast(`${title} 已启动`);
}

$("btn-refresh-env").onclick = refreshEnv;
$("btn-settarget").onclick = () =>
  guard(() => {
    const project = currentProject();
    $("project").value = project;
    rememberProject(project);
    return startJobTool("esp32_set_target", { project, target: "esp32s3" }, "set-target");
  });
$("btn-build").onclick = () =>
  guard(() => {
    const project = currentProject();
    $("project").value = project;
    rememberProject(project);
    return startJobTool("esp32_build", { project }, "编译");
  });
// iframe 沙箱会拦截原生 confirm()（静默返回 false），烧录确认用面板自绘弹窗
let pendingFlashProject = null;
$("btn-flash").onclick = () =>
  guard(() => {
    pendingFlashProject = currentProject();
    $("project").value = pendingFlashProject;
    $("flash-modal").hidden = false;
  });
$("flash-cancel").onclick = () => ($("flash-modal").hidden = true);
$("flash-ok").onclick = () =>
  guard(async () => {
    $("flash-modal").hidden = true;
    rememberProject(pendingFlashProject);
    await startJobTool(
      "esp32_flash",
      { project: pendingFlashProject, port: $("port").value || undefined },
      "烧录",
    );
  });

async function pollJob() {
  if (!job) return;
  try {
    const chunk = await call("esp32_job_logs", { jobId: job.id, cursor: jobCursor });
    jobCursor = chunk.cursor;
    if (chunk.text) {
      $("job-log").textContent += chunk.text;
      $("job-log").scrollTop = $("job-log").scrollHeight;
    }
    if (chunk.status !== "running") {
      job.status = chunk.status;
      $("job-head").textContent = `${$("job-head").textContent.split(" · ")[0]} · ${statusText(chunk.status)}`;
      job = null;
    }
  } catch (error) {
    $("job-head").textContent = `日志读取失败：${error.message}`;
    job = null;
  }
}

/* ---------- 串口日志着色 ---------- */

const ANSI_FG = {
  30: "ansi-30", 31: "ansi-31", 32: "ansi-32", 33: "ansi-33",
  34: "ansi-34", 35: "ansi-35", 36: "ansi-36", 37: "ansi-37",
  90: "ansi-90", 91: "ansi-91", 92: "ansi-92", 93: "ansi-93",
  94: "ansi-94", 95: "ansi-95", 96: "ansi-96", 97: "ansi-97",
};

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** ANSI 序列 → span class 流。SGR 处理颜色/加粗，其余控制序列（光标、DSR 探针等）吞掉。 */
function ansiToHtml(data) {
  let html = "";
  let open = 0;
  let fg = null;
  let pos = 0;
  for (const match of data.matchAll(/\x1b\[([0-9;?]*)[ -\/]*[@-~]/g)) {
    html += escapeHtml(data.slice(pos, match.index));
    pos = match.index + match[0].length;
    if (match[0].endsWith("m")) {
    const codes = (match[1] || "0").split(";").map((n) => Number(n) || 0);
    for (const code of codes) {
      if (code === 0) {
        open = 0;
        fg = null;
      } else if (code === 1) {
        open += 1;
      } else if (code === 22) {
        open = Math.max(0, open - 1);
      } else if (ANSI_FG[code]) {
        fg = ANSI_FG[code];
      } else if (code === 39) {
        fg = null;
      }
    }
    }
  }
  html += escapeHtml(data.slice(pos));
  // 统一包一层：chunk 边界处的开标签在下一段重建，避免跨段标签配对问题
  const classes = [...(fg ? [fg] : []), ...(open > 0 ? ["ansi-bold"] : [])];
  return classes.length
    ? `<span class="${classes.join(" ")}">${html}</span>`
    : html;
}

/** 无 ANSI 时的兜底：按 ESP-IDF 日志级别前缀（I/W/E/D/V (毫秒)）整行着色。 */
function fallbackToHtml(line) {
  const m =
    /(?:^|>\s*|\s)([VDIWE]) \(\d+\)/.exec(line) ?? /\b(ERROR|WARN)\b/.exec(line);
  const cls = m ? (m[1] === "ERROR" ? "E" : m[1] === "WARN" ? "W" : m[1]) : null;
  return cls && ["V", "D", "I", "W", "E"].includes(cls)
    ? `<span class="lv-${cls}">${escapeHtml(line)}</span>`
    : escapeHtml(line);
}

/** 跨 chunk 安全的日志渲染：残留半个颜色序列时扣住，拼到下一段。 */
function appendMonitorLog(text) {
  const el = $("monitor-log");
  let data = appendMonitorLog.pending + text;
  appendMonitorLog.pending = "";
  const lastEsc = data.lastIndexOf("\x1b");
  if (lastEsc !== -1) {
    const tail = data.slice(lastEsc);
    if (!/\x1b\[[0-9;?]*[ -/]*[@-~]$/.test(tail) && !tail.includes("m")) {
      appendMonitorLog.pending = tail;
      data = data.slice(0, lastEsc);
    }
  }
  if (!data) return;
  // 逐行渲染：带 ANSI 的行走 SGR 解析；无颜色码的行按日志级别前缀兜底着色
  // （混合块里设备无色打印的 I/W/E 行不再漏染）
  const html = data
    .split("\n")
    .map((line) => (line.includes("\x1b") ? ansiToHtml(line) : fallbackToHtml(line)))
    .join("\n");
  el.insertAdjacentHTML("beforeend", html);
  el.scrollTop = el.scrollHeight;
}
appendMonitorLog.pending = "";

/* ---------- 串口监视 ---------- */

let uartCommands = [];
let editIndex = -1;
let pendingSendTimer = null;

async function loadCommands() {
  try {
    const data = await call("esp32_uart_commands_get", {});
    uartCommands = Array.isArray(data.commands) ? data.commands : [];
  } catch {
    uartCommands = [];
  }
  renderCommands();
}

function renderCommands() {
  const list = $("cmd-list");
  if (!uartCommands.length) {
    list.innerHTML = '<div class="muted cmd-empty">暂无命令，点右上角 ＋ 添加</div>';
    return;
  }
  const groups = new Map();
  uartCommands.forEach((c, index) => {
    const g = c.group || "命令";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push({ ...c, index });
  });
  list.innerHTML = "";
  for (const [group, items] of groups) {
    const head = document.createElement("div");
    head.className = "cmd-group";
    head.textContent = group;
    list.appendChild(head);
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "cmd-item";
      const btn = document.createElement("button");
      btn.className = "cmd-btn";
      btn.title = `${item.text}${item.newline !== false ? "\\n" : ""}（双击编辑）`;
      const dot = document.createElement("span");
      dot.className = "cmd-dot";
      const label = document.createElement("span");
      label.textContent = item.label;
      btn.append(dot, label);
      // 单击发送（延迟以区分双击）；双击进入编辑态
      btn.onclick = () => {
        clearTimeout(pendingSendTimer);
        pendingSendTimer = setTimeout(() => sendCommand(item), 250);
      };
      btn.ondblclick = () => {
        clearTimeout(pendingSendTimer);
        openCmdForm(item.index);
      };
      const edit = document.createElement("button");
      edit.className = "cmd-edit";
      edit.title = "编辑";
      edit.textContent = "✎";
      edit.onclick = () => openCmdForm(item.index);
      const del = document.createElement("button");
      del.className = "cmd-del";
      del.title = "删除";
      del.textContent = "✕";
      del.onclick = () =>
        guard(async () => {
          uartCommands.splice(item.index, 1);
          await call("esp32_uart_commands_set", { commands: uartCommands });
          renderCommands();
        });
      row.append(btn, edit, del);
      list.appendChild(row);
    }
  }
}

function sendCommand(item) {
  if (!monitorJob) {
    toast("先开始监视，再发送命令");
    return;
  }
  guard(async () => {
    await call("esp32_monitor_send", {
      jobId: monitorJob,
      text: item.text,
      newline: item.newline !== false,
    });
    toast(`已发送 ${item.label}`);
  });
}

function openCmdForm(index) {
  editIndex = index;
  const item = index >= 0 ? uartCommands[index] : null;
  $("cmd-label").value = item?.label ?? "";
  $("cmd-text").value = item?.text ?? "";
  $("cmd-group").value = item?.group ?? "";
  $("cmd-newline").checked = item ? item.newline !== false : true;
  $("cmd-form").hidden = false;
  $("cmd-label").focus();
}

$("cmd-add").onclick = () => openCmdForm(-1);
$("cmd-cancel").onclick = () => {
  editIndex = -1;
  $("cmd-form").hidden = true;
};
$("cmd-save").onclick = () =>
  guard(async () => {
    const label = $("cmd-label").value.trim();
    const text = $("cmd-text").value;
    if (!label || !text) throw new Error("名称和发送内容都不能为空");
    if (editIndex < 0 && uartCommands.length >= 100) throw new Error("最多 100 条命令");
    const entry = {
      label,
      text,
      newline: $("cmd-newline").checked,
      ...($("cmd-group").value.trim() ? { group: $("cmd-group").value.trim() } : {}),
    };
    if (editIndex >= 0) uartCommands[editIndex] = entry;
    else uartCommands.push(entry);
    editIndex = -1;
    await call("esp32_uart_commands_set", { commands: uartCommands });
    $("cmd-form").hidden = true;
    renderCommands();
  });

$("monitor-logfile").onchange = () =>
  guard(async () => {
    if (!monitorJob) return; // 未在监视中：仅记住状态，下次开始时生效
    const enabled = $("monitor-logfile").checked;
    const data = await call("esp32_monitor_log_toggle", { jobId: monitorJob, enabled });
    $("monitor-status").textContent = enabled
      ? `已连接（作业 ${monitorJob}） · 日志: ${data.logfile}`
      : `已连接（作业 ${monitorJob}） · 日志已关闭`;
  });

$("btn-monitor-start").onclick = () =>
  guard(async () => {
    const port = $("monitor-port").value;
    if (!port || port.startsWith("（")) throw new Error("未检测到串口设备");
    const logToFile = $("monitor-logfile").checked;
    const data = await call("esp32_monitor_start", {
      port,
      baud: Number($("monitor-baud").value) || 115200,
      logToFile,
    });
    monitorJob = data.jobId;
    monitorCursor = 0;
    $("monitor-log").textContent = "";
    $("monitor-status").textContent =
      `已连接 ${port}@${data.baud}（作业 ${monitorJob}）` +
      (data.logfile ? ` · 日志: ${data.logfile}` : "");
    $("btn-monitor-start").disabled = true;
    $("btn-monitor-stop").disabled = false;
  });

$("btn-monitor-stop").onclick = () =>
  guard(async () => {
    if (!monitorJob) return;
    await call("esp32_monitor_stop", { jobId: monitorJob });
    monitorJob = null;
    $("monitor-status").textContent = "未连接";
    $("btn-monitor-start").disabled = false;
    $("btn-monitor-stop").disabled = true;
  });

function sendFromInput() {
  const text = $("monitor-input").value;
  if (!monitorJob || !text) return;
  guard(async () => {
    await call("esp32_monitor_send", {
      jobId: monitorJob,
      text,
      newline: $("send-newline").checked,
    });
    $("monitor-input").value = "";
  });
}
$("btn-monitor-send").onclick = sendFromInput;
$("monitor-input").onkeydown = (event) => {
  if (event.key === "Enter") sendFromInput();
};

/* ---------- 日志选区浮窗：选中文本 → 对话 ---------- */

const selMenu = $("sel-menu");
let selText = "";

document.addEventListener("mouseup", () => {
  setTimeout(() => {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? "";
    const inLog = Boolean(sel?.anchorNode && $("monitor-log").contains(sel.anchorNode));
    if (!text || !text.length || !inLog || !monitorLogVisible()) {
      selMenu.hidden = true;
      return;
    }
    selText = text;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const left = Math.min(Math.max(8, rect.left + rect.width / 2 - 90), window.innerWidth - 190);
    selMenu.style.left = `${left}px`;
    selMenu.style.top = `${rect.top >= 52 ? rect.top - 42 : rect.bottom + 8}px`;
    selMenu.hidden = false;
  }, 10);
});

function monitorLogVisible() {
  const page = document.getElementById("tab-monitor");
  return page && !page.hidden;
}

document.addEventListener("mousedown", (event) => {
  if (!selMenu.contains(event.target)) selMenu.hidden = true;
});
document.addEventListener("scroll", () => (selMenu.hidden = true), true);

selMenu.addEventListener("click", (event) => {
  const act = event.target?.dataset?.act;
  if (!act) return;
  const truncated = selText.length > 4000 ? `${selText.slice(0, 4000)}\n…（已截断）` : selText;
  selMenu.hidden = true;
  window.getSelection()?.removeAllRanges();
  if (act === "task") {
    guard(async () => {
      await app.updateModelContext({
        content: [
          { type: "text", text: `【串口日志选段（用户在面板中选中）】\n${truncated}` },
        ],
      });
      toast("已添加到输入区上下文，可继续提问");
    });
  } else {
    guard(async () => {
      await app.sendMessage({
        role: "user",
        content: [{ type: "text", text: `请帮我分析这段串口日志输出：\n\n${truncated}` }],
      });
      toast("已发送到对话");
    });
  }
});

// 点开串口下拉即刻刷新列表（两个 Tab 共用同一环境数据）
$("port").onclick = () => refreshEnv();
$("monitor-port").onclick = () => refreshEnv();

async function pollMonitor() {
  if (!monitorJob) return;
  try {
    const chunk = await call("esp32_monitor_read", {
      jobId: monitorJob,
      cursor: monitorCursor,
      ansi: true,
    });
    monitorCursor = chunk.cursor;
    if (chunk.text) appendMonitorLog(chunk.text);
    if (chunk.status !== "running") {
      $("monitor-status").textContent = `连接已断开（${statusText(chunk.status)}）`;
      monitorJob = null;
      $("btn-monitor-start").disabled = false;
      $("btn-monitor-stop").disabled = true;
    }
  } catch (error) {
    $("monitor-status").textContent = `读取失败：${error.message}`;
    monitorJob = null;
    $("btn-monitor-start").disabled = false;
    $("btn-monitor-stop").disabled = true;
  }
}

/* ---------- 公共 ---------- */

function statusText(status) {
  return { running: "运行中", succeeded: "成功", failed: "失败", cancelled: "已取消", interrupted: "已中断" }[status] ?? status;
}

async function guard(action) {
  try {
    await action();
  } catch (error) {
    toast(error.message || String(error));
  }
}

for (const tab of document.querySelectorAll(".tab")) {
  tab.onclick = () => {
    for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t === tab);
    for (const page of document.querySelectorAll(".page")) page.hidden = page.id !== `tab-${tab.dataset.tab}`;
    if (tab.dataset.tab === "pipeline") {
      refreshEnv();
      loadProjects();
    }
  };
}

app.onteardown = () => {
  stopPolling();
};

async function main() {
  await app.connect();
  applyTheme();
  loadChip();
  loadCommands();
  refreshEnv(); // 首次打开即加载串口列表；之后仍按点击刷新
  startPolling();
}
main();
