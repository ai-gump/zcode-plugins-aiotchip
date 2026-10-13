// build/flash 内联作业卡：从工具结果拿到 jobId，轮询日志直到终态。
import { App } from "@modelcontextprotocol/ext-apps";

const app = new App(
  { name: "esp32-ai-builder-card", version: "0.2.0" },
  { availableDisplayModes: ["inline"] },
);

const STATUS_TEXT = {
  running: "运行中",
  succeeded: "成功",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};

let timer = null;

function applyTheme() {
  document.body.dataset.theme = app.getHostContext()?.theme === "dark" ? "dark" : "light";
}
app.onhostcontextchanged = applyTheme;

async function poll(jobId, cursorRef) {
  const result = await app.callServerTool({
    name: "esp32_job_logs",
    arguments: { jobId, cursor: cursorRef.value },
  });
  if (result.isError) throw new Error((result.content ?? [])[0]?.text ?? "日志读取失败");
  const chunk = result.structuredContent ?? {};
  cursorRef.value = chunk.cursor ?? cursorRef.value;
  if (chunk.text) {
    document.getElementById("log").textContent += chunk.text;
    const log = document.getElementById("log");
    log.scrollTop = log.scrollHeight;
  }
  if (chunk.status && chunk.status !== "running") {
    setStatus(chunk.status);
    clearInterval(timer);
    timer = null;
  }
}

function setStatus(status) {
  document.getElementById("status").textContent = STATUS_TEXT[status] ?? status;
}

app.onteardown = () => {
  if (timer) clearInterval(timer);
};

app.ontoolresult = (result) => {
  const data = result.structuredContent ?? {};
  if (!data.jobId) return;
  document.getElementById("job-id").textContent = data.jobId;
  document.getElementById("kind").textContent = data.kind ?? "作业";
  setStatus(data.status ?? "running");
  const cursorRef = { value: 0 };
  timer = setInterval(() => {
    poll(data.jobId, cursorRef).catch((error) => {
      document.getElementById("log").textContent += `\n[card] ${error.message}`;
      clearInterval(timer);
      timer = null;
    });
  }, 1000);
};

async function main() {
  await app.connect();
  applyTheme();
}
main();
