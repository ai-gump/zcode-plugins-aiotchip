// ESP32 AI 开发台面板客户端（MCP Apps）。先注册事件再 connect()；能力协商决定可选功能。
import { App } from "@modelcontextprotocol/ext-apps";

const app = new App(
  { name: "esp32-ai-builder-panel", version: "0.2.0" },
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
      content:
        "用户在 ESP32 AI 开发台面板中查看了 ESP32-S3 选型信息（双核 LX7 240MHz、512KB SRAM、内置 USB-Serial-JTAG、AI 向量指令），希望围绕 ESP32-S3 继续讨论。",
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

async function refreshEnv() {
  $("env-line").textContent = "检查环境中…";
  try {
    const env = await call("esp32_env_check", {});
    const idf = env.idf;
    $("env-line").textContent = env.ready
      ? `环境就绪：ESP-IDF ${idf.version} @ ${idf.path}`
      : `环境未就绪：${(env.suggestions ?? []).join(" ")}`;
    portsToSelect($("port"), env.serialPorts ?? []);
    portsToSelect($("monitor-port"), env.serialPorts ?? []);
  } catch (error) {
    $("env-line").textContent = `环境检查失败：${error.message}`;
  }
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
  guard(() => startJobTool("esp32_set_target", { project: $("project").value.trim(), target: "esp32s3" }, "set-target"));
$("btn-build").onclick = () =>
  guard(() => startJobTool("esp32_build", { project: $("project").value.trim() }, "编译"));
$("btn-flash").onclick = async () => {
  if (!confirm("烧录将覆写开发板 flash，确认继续？")) return;
  await guard(() =>
    startJobTool(
      "esp32_flash",
      { project: $("project").value.trim(), port: $("port").value || undefined },
      "烧录",
    ),
  );
};

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

/* ---------- 串口监视 ---------- */

$("btn-monitor-start").onclick = () =>
  guard(async () => {
    const port = $("monitor-port").value;
    if (!port || port.startsWith("（")) throw new Error("未检测到串口设备");
    const data = await call("esp32_monitor_start", {
      port,
      baud: Number($("monitor-baud").value) || 115200,
    });
    monitorJob = data.jobId;
    monitorCursor = 0;
    $("monitor-log").textContent = "";
    $("monitor-status").textContent = `已连接 ${port}@${data.baud}（作业 ${monitorJob}）`;
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

$("btn-monitor-send").onclick = () =>
  guard(async () => {
    const text = $("monitor-input").value;
    if (!monitorJob || !text) return;
    await call("esp32_monitor_send", { jobId: monitorJob, text });
    $("monitor-input").value = "";
    toast("已发送");
  });

async function pollMonitor() {
  if (!monitorJob) return;
  try {
    const chunk = await call("esp32_monitor_read", { jobId: monitorJob, cursor: monitorCursor });
    monitorCursor = chunk.cursor;
    if (chunk.text) {
      $("monitor-log").textContent += chunk.text;
      $("monitor-log").scrollTop = $("monitor-log").scrollHeight;
    }
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
    if (tab.dataset.tab === "pipeline") refreshEnv();
  };
}

app.onteardown = () => {
  stopPolling();
};

async function main() {
  await app.connect();
  applyTheme();
  loadChip();
  startPolling();
}
main();
