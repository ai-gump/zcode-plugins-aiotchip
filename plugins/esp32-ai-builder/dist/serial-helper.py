#!/usr/bin/env python3
"""esp32-ai-builder 串口助手（由 IDF 自带的 python 执行，pyserial 随 IDF 工具链提供）。

读模式：持续把串口原始字节写入 --log（无缓冲），直到进程被终止。
写模式：--send-text 打开端口写入一次文本后立即退出。
注意：部分板卡的 USB 转串口驱动在打开瞬间翻转 DTR/RTS 会复位 ESP32，助手显式拉低以降低概率，
但不能完全避免；连续输出场景推荐读模式常驻、写模式复用已打开的连接由读进程持有。
"""
import argparse
import sys

import serial


def main() -> None:
    parser = argparse.ArgumentParser(description="esp32-ai-builder serial helper")
    parser.add_argument("--port", required=True)
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument("--log", help="append raw serial bytes to this file (reader mode)")
    parser.add_argument("--send-text", help="write this text once, then exit (writer mode)")
    parser.add_argument("--send-newline", action="store_true", help="append \\n to the sent text")
    args = parser.parse_args()

    if args.send_text is not None or args.send_newline:
        with serial.serial_for_url(args.port, args.baud, timeout=1) as port:
            port.dtr = False
            port.rts = False
            data = (args.send_text or "") + ("\n" if args.send_newline else "")
            port.write(data.encode("utf-8", "replace"))
        return

    if not args.log:
        parser.error("reader mode requires --log")
    with serial.serial_for_url(args.port, args.baud, timeout=0.25) as port:
        port.dtr = False
        port.rts = False
        with open(args.log, "ab", buffering=0) as out:
            try:
                while True:
                    data = port.read(4096)
                    if data:
                        out.write(data)
            except serial.SerialException as exc:
                print(f"serial closed: {exc}", file=sys.stderr)


if __name__ == "__main__":
    main()
