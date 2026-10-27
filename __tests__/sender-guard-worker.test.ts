/**
 * Where the sender limits apply in the worker.
 *   - The loop check (a sender faster than a person) runs for every inbound
 *     message and every button tap.
 *   - The hourly cap counts only what starts an automatic reply. A customer who
 *     is answering a form, a menu or a comment-reply prompt is in a conversation
 *     we began, so their answers are never counted: otherwise a long form is
 *     silently dropped at message 21.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  checkLoop: vi.fn(),
  checkAutoReplyCap: vi.fn(),
  handleFormMessage: vi.fn(),
  claimCommentAnswer: vi.fn(),
  pickCommand: vi.fn(),
  touchContact: vi.fn(),
  queueAdd: vi.fn(),
}));

vi.mock("@/lib/automation/sender-guard", () => ({ checkLoop: m.checkLoop, checkAutoReplyCap: m.checkAutoReplyCap }));
vi.mock("@/lib/forms/engine", async (orig) => ({ ...(await orig<object>()), handleFormMessage: m.handleFormMessage }));
vi.mock("@/lib/conversations/sessions", async (orig) => ({ ...(await orig<object>()), claimCommentAnswer: m.claimCommentAnswer }));
vi.mock("@/lib/commands/engine", async (orig) => ({
  ...(await orig<object>()),
  pickCommand: m.pickCommand,
  activeCommandsFor: async () => [],
  commandFromPayload: async () => null,
}));
vi.mock("@/lib/contacts/touch", async (orig) => ({ ...(await orig<object>()), touchContact: m.touchContact }));
vi.mock("@/lib/db/client", () => ({
  prisma: new Proxy({}, { get: () => new Proxy({}, { get: () => async () => null }) }),
}));
vi.mock("@/lib/ops/worker-health", () => ({ recordWorkerAlert: vi.fn() }));
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({ add: m.queueAdd }),
  getRedisConnection: vi.fn(),
  POSTBACK_JOB_NAME: "process-postback",
  FOLLOWUP_JOB_NAME: "process-followup",
  MESSAGE_JOB_NAME: "process-message",
  SEQUENCE_JOB_NAME: "process-sequence-step",
  SMS_JOB_NAME: "process-sms-batch",
}));
vi.mock("bullmq", () => ({
  Worker: function (_name: string, processor: unknown) {
    (global as Record<string, unknown>).__dmWorkerProcessor = processor;
    return { on: vi.fn(), close: vi.fn() };
  },
  UnrecoverableError: class extends Error {},
}));

import { createDMWorker } from "../lib/queue/dm-worker";

type Job = { name: string; data: Record<string, unknown>; id: string; attemptsMade: number };
function processor(): (job: Job) => Promise<void> {
  createDMWorker();
  return (global as Record<string, unknown>).__dmWorkerProcessor as (job: Job) => Promise<void>;
}
const message = (data: Record<string, unknown> = {}): Job => ({
  name: "process-message",
  id: "j1",
  attemptsMade: 0,
  data: { instagramAccountId: "ig_456", messageId: "mid1", messageText: "hello", senderId: "cust1", ...data },
});
const postback = (data: Record<string, unknown> = {}): Job => ({
  name: "process-postback",
  id: "j2",
  attemptsMade: 0,
  data: { instagramAccountId: "ig_456", userId: "cust1", payload: "reveal:auto1", mid: "pm1", ...data },
});

beforeEach(() => {
  vi.clearAllMocks();
  m.checkLoop.mockResolvedValue("allow");
  m.checkAutoReplyCap.mockResolvedValue("allow");
  m.handleFormMessage.mockResolvedValue(false);
  m.claimCommentAnswer.mockResolvedValue(null);
  m.pickCommand.mockReturnValue(null);
  m.touchContact.mockResolvedValue(undefined);
});

describe("the hourly cap", () => {
  it("does not count a message that answers an open form", async () => {
    m.handleFormMessage.mockResolvedValue(true);
    await processor()(message());
    expect(m.checkLoop).toHaveBeenCalledTimes(1);
    expect(m.checkAutoReplyCap).not.toHaveBeenCalled();
  });

  it("does not count the answer to a comment-reply prompt (an active session)", async () => {
    m.claimCommentAnswer.mockResolvedValue({ id: "s1", instagramAccountId: "row1", payload: "reveal:auto1" });
    await processor()(message());
    expect(m.checkAutoReplyCap).not.toHaveBeenCalled();
    expect(m.queueAdd).toHaveBeenCalled();
  });

  it("counts a message that would start an automatic reply, and stops it over the cap", async () => {
    m.checkAutoReplyCap.mockResolvedValue("over_hourly_cap");
    await processor()(message());
    expect(m.checkAutoReplyCap).toHaveBeenCalledWith(expect.objectContaining({ senderId: "cust1", messageId: "mid1" }));
    expect(m.pickCommand).not.toHaveBeenCalled();
  });

  it("applies to a story reply or mention like any other message", async () => {
    m.checkAutoReplyCap.mockResolvedValue("over_hourly_cap");
    await processor()(message({ storyId: "st1", messageText: "" }));
    expect(m.checkLoop).toHaveBeenCalled();
    expect(m.checkAutoReplyCap).toHaveBeenCalled();
    expect(m.pickCommand).not.toHaveBeenCalled();
  });
});

describe("the loop check", () => {
  it("stops a paused sender before a form or anything else is looked at", async () => {
    m.checkLoop.mockResolvedValue("loop_paused");
    await processor()(message());
    expect(m.handleFormMessage).not.toHaveBeenCalled();
    expect(m.touchContact).not.toHaveBeenCalled();
  });

  it("runs on a button tap, and a paused sender's tap is not answered", async () => {
    m.checkLoop.mockResolvedValue("loop_paused");
    await processor()(postback());
    expect(m.checkLoop).toHaveBeenCalledWith(expect.objectContaining({ senderId: "cust1", messageId: "tap:pm1" }));
    expect(m.touchContact).not.toHaveBeenCalled();
  });

  it("does not count a tap toward the hourly cap: the button belongs to a conversation we began", async () => {
    await processor()(postback());
    expect(m.checkLoop).toHaveBeenCalled();
    expect(m.checkAutoReplyCap).not.toHaveBeenCalled();
  });
});
