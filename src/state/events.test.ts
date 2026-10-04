import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { EVENT_ENVELOPE_VERSION, type EventEnvelope, EventEnvelopeSchema } from "./events.ts";
import { newEntryId, newRunId, newSessionId } from "./ids.ts";

function makeEvent(): EventEnvelope {
  return {
    version: EVENT_ENVELOPE_VERSION,
    id: newEntryId(),
    sessionId: newSessionId(),
    runId: newRunId(),
    timestamp: Date.now(),
    kind: "run.created",
    payload: { note: "首次运行" },
  };
}

test("version 不符被拒绝", () => {
  const bad = { ...makeEvent(), version: EVENT_ENVELOPE_VERSION + 1 };
  assert.ok(!Value.Check(EventEnvelopeSchema, bad));
});

test("id 前缀错配被拒绝", () => {
  const bad = { ...makeEvent(), id: newRunId() as string };
  assert.ok(!Value.Check(EventEnvelopeSchema, bad));
});

test("缺字段被拒绝", () => {
  const { kind: _, ...bad } = makeEvent();
  assert.ok(!Value.Check(EventEnvelopeSchema, bad));
});
