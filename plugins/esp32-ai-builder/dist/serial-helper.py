#!/usr/bin/env python3
"""esp32-ai-builder 串口助手（由 IDF 自带的 python 执行，pyserial 随 IDF 工具链提供）。

读模式：独占端口持续读取，直到进程被终止。
  --log      原始字节直写（面板流式渲染用）
  --logfile  额外落盘：按行缓冲，每行加 "%m-%d %H:%M:%S.<毫秒> -- " 时间戳前缀
  stdin      后台线程逐行读 JSON 指令 {"text","newline"} 写入同一端口——
             发送不重开端口，避免二次 open 翻转 DTR/RTS 触发 USB-Serial-JTAG 复位
写模式（--send-text）：独立打开端口写一次文本后退出，仅供手动调试使用。
注意：部分板卡的 USB 转串口驱动在打开瞬间翻转 DTR/RTS 会复位 ESP32，助手显式拉低以降低概率，
但不能完全避免——所以常驻读模式下的发送一律走 stdin 通道。
"""
import argparse
import json
import sys
import threading
import time
from datetime import datetime

import serial


def timestamp() -> bytes:
    now = datetime.now()
    return f"{now.strftime('%m-%d %H:%M:%S.')}{now.microsecond // 1000:03d} -- ".encode()


def stdin_command_loop(port) -> threading.Thread:
    def loop() -> None:
        while True:
            try:
                line = sys.stdin.buffer.readline()
                if not line:
                    time.sleep(0.1)  # 服务端已退出：保持读串口直到作业被终止
                    continue
                cmd = json.loads(line)
                text = str(cmd.get("text", ""))
                data = text + ("\n" if cmd.get("newline", True) else "")
                port.write(data.encode("utf-8", "replace"))
            except Exception as exc:  # noqa: BLE001 — 单条指令失败不中断读取
                print(f"command error: {exc}", file=sys.stderr)

    thread = threading.Thread(target=loop, daemon=True)
    thread.start()
    return thread


def reader(port, args) -> None:
    raw = open(args.log, "ab", buffering=0) if args.log else None
    plain = open(args.logfile, "ab", buffering=0) if args.logfile else None
    buf = b""
    try:
        while True:
            data = port.read(4096)
            if not data:
                continue
            if raw:
                raw.write(data)
            if plain:
                buf += data
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    if line.endswith(b"\r"):
                        line = line[:-1]
                    plain.write(timestamp() + line + b"\n")
    except serial.SerialException as exc:
        print(f"serial closed: {exc}", file=sys.stderr)
    finally:
        if plain and buf:
            plain.write(timestamp() + buf + b"\n")


def main() -> None:
    parser = argparse.ArgumentParser(description="esp32-ai-builder serial helper")
    parser.add_argument("--port", required=True)
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument("--log", help="append raw serial bytes to this file (reader mode)")
    parser.add_argument(
        "--logfile",
        help="additionally write timestamped, line-buffered text to this file (reader mode)",
    )
    parser.add_argument("--send-text", help="write this text once, then exit (manual writer mode)")
    parser.add_argument("--send-newline", action="store_true", help="append \\n to the sent text")
    args = parser.parse_args()

    if args.send_text is not None or args.send_newline:
        with serial.serial_for_url(args.port, args.baud, timeout=1) as port:
            port.dtr = False
            port.rts = False
            data = (args.send_text or "") + ("\n" if args.send_newline else "")
            port.write(data.encode("utf-8", "replace"))
        return

    if not args.log and not args.logfile:
        parser.error("reader mode requires --log or --logfile")
    with serial.serial_for_url(args.port, args.baud, timeout=0.25) as port:
        port.dtr = False
        port.rts = False
        stdin_command_loop(port)
        reader(port, args)


if __name__ == "__main__":
    main()
