"""OSC client for SuperDirt (previews, reachability) and the sclang bank-load hook."""

import socket
import threading
import time
from pathlib import Path

from pythonosc.osc_bundle_builder import OscBundleBuilder
from pythonosc.osc_message import OscMessage
from pythonosc.osc_message_builder import OscMessageBuilder

from . import config

PREVIEW_ORBIT = 12
PREVIEW_DELAY = 0.1


def _message(address: str, args: list):
    b = OscMessageBuilder(address=address)
    for a in args:
        b.add_arg(a)
    return b.build()


class Dirt:
    def __init__(self, addr: tuple[str, int] = config.DIRT_ADDR, reply_port: int = 0):
        self.addr = addr
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._sock.bind(("127.0.0.1", reply_port))
        self._lock = threading.Lock()

    def close(self) -> None:
        self._sock.close()

    def _send(self, packet) -> None:
        try:
            self._sock.sendto(packet.dgram, self.addr)
        except OSError:
            pass  # nothing listening / network hiccup: previews are best effort

    def _drain(self) -> None:
        """Discard stale replies. Caller holds the lock."""
        self._sock.setblocking(False)
        try:
            while True:
                self._sock.recvfrom(65535)
        except OSError:
            pass

    def _wait_for(self, address: str, timeout: float) -> list | None:
        """Return the args of the first `address` message within `timeout`, else None."""
        end = time.monotonic() + timeout
        try:
            while (left := end - time.monotonic()) > 0:
                self._sock.settimeout(left)
                try:
                    data, _ = self._sock.recvfrom(65535)
                except OSError:
                    return None
                try:
                    msg = OscMessage(data)
                except Exception:
                    continue
                if msg.address == address:
                    return list(msg.params)
            return None
        finally:
            self._sock.settimeout(None)

    def play(self, bank: str, n: int) -> None:
        pairs = ["s", bank, "n", float(n), "orbit", PREVIEW_ORBIT, "cut", 1,
                 "cps", 1.0, "cycle", 0.0, "delta", 1.0]
        bundle = OscBundleBuilder(time.time() + PREVIEW_DELAY)
        bundle.add_content(_message("/dirt/play", pairs))
        self._send(bundle.build())

    def hello(self, timeout: float = 0.5) -> bool:
        with self._lock:
            self._drain()
            self._send(_message("/dirt/hello", []))
            return self._wait_for("/dirt/hello/reply", timeout) is not None

    def load_bank(self, path: Path, name: str, timeout: float = 3.0) -> int | None:
        with self._lock:
            self._drain()
            self._send(_message("/samplebank/load", [str(path), name]))
            end = time.monotonic() + timeout
            while (left := end - time.monotonic()) > 0:
                reply = self._wait_for("/samplebank/loaded", left)
                if reply is None:
                    return None
                if len(reply) >= 2 and str(reply[0]) == name:
                    return int(reply[1])
            return None
