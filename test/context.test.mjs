import assert from "node:assert/strict";
import test from "node:test";
import { compact, estimate } from "../dist/context.js";

const user = (content) => ({ role: "user", content });
const assistant = (content, calls) => ({
  role: "assistant",
  content,
  ...(calls ? { calls } : {}),
});
const tool = (callId, content) => ({ role: "tool", content, callId });

test("estimate counts UTF-8 bytes for strings and serialized objects", () => {
  assert.equal(estimate("abcd"), 4);
  assert.equal(estimate("日本"), 6);
  assert.equal(estimate({ a: 1 }), '{"a":1}'.length);
});

test("budgets under 1 KiB are rejected with the context exit code", () => {
  assert.throws(
    () => compact([user("hi")], 1023),
    (error) => {
      assert.match(error.message, /too small/);
      assert.equal(error.exitCode, 4);
      return true;
    },
  );
});

test("everything is kept when it fits and nothing is prepended", () => {
  const messages = [user("a"), assistant("b"), user("c"), assistant("d")];
  const result = compact(messages, 4096);
  assert.deepEqual(result, { messages, omitted: 0 });
});

test("older complete turns are dropped first and tool call/result pairs stay together", () => {
  const call = { id: "c1", name: "file_read", arguments: { path: "x" } };
  const turn1 = [
    user("first question"),
    assistant("", [call]),
    tool("c1", "x".repeat(600)),
    assistant("answer one"),
  ];
  const turn2 = [
    user("second question"),
    assistant("", [{ ...call, id: "c2" }]),
    tool("c2", "y".repeat(600)),
    assistant("answer two"),
  ];
  const turn3 = [user("third"), assistant("three")];
  const result = compact([...turn1, ...turn2, ...turn3], 1500);
  assert.equal(result.omitted, 1);
  assert.equal(result.messages[0].role, "user");
  assert.match(result.messages[0].content, /1 earlier complete turns omitted/);
  assert.deepEqual(result.messages.slice(1), [...turn2, ...turn3]);
  // No orphaned tool results: every tool message follows an assistant call with the same id.
  for (let i = 1; i < result.messages.length; i++) {
    const message = result.messages[i];
    if (message.role !== "tool") continue;
    const previous = result.messages[i - 1];
    assert.equal(previous.role, "assistant");
    assert.ok(previous.calls.some((c) => c.id === message.callId));
  }
});

test("the current turn alone must fit, otherwise compaction fails clearly", () => {
  const history = [user("old"), assistant("old answer")];
  const current = [user("z".repeat(2000))];
  assert.throws(
    () => compact([...history, ...current], 1500),
    (error) => {
      assert.match(error.message, /Current turn exceeds context budget/);
      assert.equal(error.exitCode, 4);
      return true;
    },
  );
});

test("a leading assistant message without a user turn forms its own droppable group", () => {
  const messages = [assistant("i".repeat(900)), user("q"), assistant("a")];
  assert.deepEqual(compact(messages, 4096), { messages, omitted: 0 });
  const tight = compact(messages, 1024);
  assert.equal(tight.omitted, 1);
  assert.deepEqual(tight.messages.slice(1), messages.slice(1));
});

test("the omission notice counts all dropped turns and the original input is not mutated", () => {
  const turns = [];
  for (let i = 0; i < 20; i++)
    turns.push(
      user(`question ${i} ` + "p".repeat(200)),
      assistant(`answer ${i}`),
    );
  const snapshot = structuredClone(turns);
  const result = compact(turns, 1400);
  assert.deepEqual(turns, snapshot);
  assert.ok(result.omitted >= 15, `omitted ${result.omitted}`);
  assert.match(
    result.messages[0].content,
    new RegExp(`${result.omitted} earlier complete turns omitted`),
  );
  assert.equal(result.messages.length, 1 + (20 - result.omitted) * 2);
  assert.ok(estimate(result.messages.slice(1)) + 256 <= 1400);
});
