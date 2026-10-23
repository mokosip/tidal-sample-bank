import threading
import time
from pathlib import Path

import pytest
from pythonosc.dispatcher import Dispatcher
from pythonosc.osc_server import ThreadingOSCUDPServer
from pythonosc.udp_client import SimpleUDPClient

from samplebank.dirt import Dirt


class Fake:
    """Fake SuperDirt/sclang on a free port; replies go to the sender address."""

    def __init__(self, replies: dict[str, tuple[str, list]] | None = None):
        self.received: list[tuple[str, tuple]] = []
        self.replies = replies or {}
        disp = Dispatcher()
        disp.set_default_handler(self._handle, needs_reply_address=True)
        self.server = ThreadingOSCUDPServer(("127.0.0.1", 0), disp)
        self.addr = ("127.0.0.1", self.server.server_address[1])
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def _handle(self, client, address, *args):
        self.received.append((address, args))
        if address in self.replies:
            r_addr, r_args = self.replies[address]
            SimpleUDPClient(*client).send_message(r_addr, r_args)

    def wait_for(self, address: str, timeout=2.0):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            for a, args in self.received:
                if a == address:
                    return args
            time.sleep(0.01)
        raise AssertionError(f"no {address} received: {self.received}")

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)


@pytest.fixture
def make_fake():
    fakes: list[Fake] = []
    dirts: list[Dirt] = []

    def _make(replies=None):
        f = Fake(replies)
        fakes.append(f)
        d = Dirt(addr=f.addr)
        dirts.append(d)
        return f, d

    yield _make
    for d in dirts:
        d.close()
    for f in fakes:
        f.close()


def test_play_sends_expected_pairs(make_fake):
    fake, dirt = make_fake()
    dirt.play("bd", 3)
    args = list(fake.wait_for("/dirt/play"))
    pairs = dict(zip(args[0::2], args[1::2]))
    assert pairs == {
        "s": "bd",
        "n": 3.0,
        "orbit": 12,
        "cut": 1,
        "cps": 1.0,
        "cycle": 0.0,
        "delta": 1.0,
    }
    assert isinstance(pairs["n"], float)


def test_hello_true_when_reply(make_fake):
    _, dirt = make_fake({"/dirt/hello": ("/dirt/hello/reply", [])})
    assert dirt.hello() is True


def test_hello_false_on_silence(make_fake):
    _, dirt = make_fake()
    t0 = time.monotonic()
    assert dirt.hello() is False
    assert time.monotonic() - t0 < 0.6


def test_load_bank_returns_count(make_fake, tmp_path: Path):
    fake, dirt = make_fake({"/samplebank/load": ("/samplebank/loaded", ["kicks", 4])})
    assert dirt.load_bank(tmp_path / "kicks", "kicks") == 4
    assert fake.wait_for("/samplebank/load") == (str(tmp_path / "kicks"), "kicks")


def test_load_bank_none_on_timeout(make_fake, tmp_path: Path):
    _, dirt = make_fake()
    assert dirt.load_bank(tmp_path, "x", timeout=0.2) is None
