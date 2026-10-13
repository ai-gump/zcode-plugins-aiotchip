#!/usr/bin/env python3
"""esp32-ai-builder 串口助手（由 IDF 自带的 python 执行，pyserial 随 IDF 工具链提供）。

读模式：独占端口持续读取，直到进程被终止。
  --log      原始字节直写（面板流式渲染用）
  --logfile  初始落盘文件：按行缓冲，每行加 "%m-%d %H:%M:%S.<毫秒> -- " 时间戳前缀
  stdin      后台线程逐行读 JSON 指令写入同一端口（发送不重开端口，避免翻转
             DTR/RTS 触发 USB-Serial-JTAG 复位）：
               {"text","newline"}        发送文本；newline 追加 "\\r\\n"
               {"cmd":"logon","logfile"} 动态开启时间戳落盘（新建文件）
               {"cmd":"logoff"}          关闭落盘
写模式（--send-text）：独立打开端口写一次文本后退出，仅供手动调试使用。
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


def close_plain(plain_holder) -> None:
    f = plain_holder.get("f")
    if f:
        leftover = plain_holder.get("buf") or b""
        if leftover:
            f.write(timestamp() + leftover + b"\n")
        f.close()
        plain_holder["f"] = None
        plain_holder["buf"] = b""
        print("log file closed", file=sys.stderr)


def stdin_command_loop(port, plain_holder) -> threading.Thread:
    def loop() -> None:
        while True:
            try:
                line = sys.stdin.buffer.readline()
                if not line:
                    time.sleep(0.1)  # 服务端已退出：保持读串口直到作业被终止
                    continue
                cmd = json.loads(line)
                if cmd.get("cmd") == "logon":
                    close_plain(plain_holder)
                    plain_holder["f"] = open(cmd["logfile"], "ab", buffering=0)
                    print(f"log file opened: {cmd['logfile']}", file=sys.stderr)
                elif cmd.get("cmd") == "logoff":
                    close_plain(plain_holder)
                else:
                    text = str(cmd.get("text", ""))
                    if text:
                        # 文本已以换行结尾则不再追加，避免双换行
                        needs_newline = cmd.get("newline", True) and not text.endswith(("\r", "\n"))
                        data = text + ("\r\n" if needs_newline else "")
                        port.write(data.encode("utf-8", "replace"))
            except Exception as exc:  # noqa: BLE001 — 单条指令失败不中断读取
                print(f"command error: {exc}", file=sys.stderr)

    thread = threading.Thread(target=loop, daemon=True)
    thread.start()
    return thread


def reader(port, args, plain_holder) -> None:
    raw = open(args.log, "ab", buffering=0) if args.log else None
    if args.logfile:
        plain_holder["f"] = open(args.logfile, "ab", buffering=0)
    try:
        while True:
            data = port.read(4096)
            if not data:
                continue
            if raw:
                raw.write(data)
            # 应答终端探针（与 idf.py monitor 一致）：设备 console 依赖它启用行编辑，
            # 否则打印 "terminal does not support escape sequences" 并禁用。
            if b"\x1b[6n" in data:
                port.write(b"\x1b[1;1R")
            elif b"\x1b[5n" in data:
                port.write(b"\x1b[0n")
            plain = plain_holder.get("f")
            if plain:
                plain_holder["buf"] += data
                while b"\n" in plain_holder["buf"]:
                    line, plain_holder["buf"] = plain_holder["buf"].split(b"\n", 1)
                    if line.endswith(b"\r"):
                        line = line[:-1]
                    plain.write(timestamp() + line + b"\n")
    except serial.SerialException as exc:
        print(f"serial closed: {exc}", file=sys.stderr)
    finally:
        close_plain(plain_holder)


def main() -> None:
    parser = argparse.ArgumentParser(description="esp32-ai-builder serial helper")
    parser.add_argument("--port", required=True)
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument("--log", help="append raw serial bytes to this file (reader mode)")
    parser.add_argument(
        "--logfile",
        help="initial timestamped, line-buffered log file (reader mode; toggleable via stdin)",
    )
    parser.add_argument("--send-text", help="write this text once, then exit (manual writer mode)")
    parser.add_argument("--send-newline", action="store_true", help="append \\r\\n to the sent text")
    args = parser.parse_args()

    if args.send_text is not None or args.send_newline:
        with serial.serial_for_url(args.port, args.baud, timeout=1) as port:
            port.dtr = False
            port.rts = False
            data = (args.send_text or "") + ("\r\n" if args.send_newline else "")
            port.write(data.encode("utf-8", "replace"))
        return

    if not args.log and not args.logfile:
        parser.error("reader mode requires --log or --logfile")
    with serial.serial_for_url(args.port, args.baud, timeout=0.25) as port:
        port.dtr = False
        port.rts = False
        holder = {"f": None, "buf": b""}
        stdin_command_loop(port, holder)
        reader(port, args, holder)


if __name__ == "__main__":
    main()
