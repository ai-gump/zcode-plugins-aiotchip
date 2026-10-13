// 串口工具：macOS/Linux 设备扫描。串口互斥锁由 server 持有（每会话一个服务进程）。
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const PREFIXES = ["tty.usb", "tty.usbmodem", "tty.usbserial", "ttyUSB", "ttyACM", "tty.usbmodem"];

export async function listSerialPorts(): Promise<string[]> {
  const entries = await readdir("/dev");
  return entries
    .filter((name) => PREFIXES.some((prefix) => name.startsWith(prefix)))
    .map((name) => join("/dev", name))
    .sort();
}
