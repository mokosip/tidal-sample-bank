import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { throttle } from "../../src/samplebank/static/throttle.js";

test("10 calls within 30 ms -> 1 immediate send + 1 trailing send with the last id", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const sent = [];
    const play = throttle((id) => sent.push(id), 60);
    for (let i = 0; i < 10; i++) {
      play(`id${i}`);
      mock.timers.tick(3); // 10 calls spread over 30 ms
    }
    assert.deepEqual(sent, ["id0"], "only the leading call goes out immediately");
    mock.timers.tick(500);
    assert.deepEqual(sent, ["id0", "id9"]);
  } finally {
    mock.timers.reset();
  }
});

test("sends are at least 60 ms apart", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const sent = [];
    const play = throttle((id) => sent.push(id), 60);
    play("a");
    play("b");
    mock.timers.tick(59);
    assert.deepEqual(sent, ["a"]);
    mock.timers.tick(1);
    assert.deepEqual(sent, ["a", "b"]);
    play("c"); // still inside the window opened by the trailing send
    mock.timers.tick(59);
    assert.deepEqual(sent, ["a", "b"]);
    mock.timers.tick(1);
    assert.deepEqual(sent, ["a", "b", "c"]);
  } finally {
    mock.timers.reset();
  }
});

test("a call after a quiet period goes out immediately", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const sent = [];
    const play = throttle((id) => sent.push(id), 60);
    play("a");
    mock.timers.tick(200);
    play("b");
    assert.deepEqual(sent, ["a", "b"]);
  } finally {
    mock.timers.reset();
  }
});
