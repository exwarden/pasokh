/**
 * The address a request connects to is the one that was checked: the check
 * runs inside the socket's own name lookup, so there is no second resolve for
 * a hostile DNS server to answer differently (DNS rebinding). The body of the
 * answer is capped.
 */
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  answers: [] as { address: string; family: number }[][],
  lookupCalls: 0,
  requestOptions: null as null | { lookup?: (...a: unknown[]) => void },
  respond: null as null | ((res: EventEmitter & { statusCode?: number; headers?: object; destroy?: () => void }) => void),
}));

vi.mock("node:dns", () => ({
  lookup: (_host: string, _opts: unknown, cb: (e: Error | null, a: unknown) => void) => {
    m.lookupCalls++;
    cb(null, m.answers.shift() ?? [{ address: "93.184.216.34", family: 4 }]);
  },
}));
vi.mock("node:https", () => ({
  default: {
    request: (_url: unknown, options: { lookup?: (...a: unknown[]) => void }, onResponse: (r: unknown) => void) => {
      m.requestOptions = options;
      const req = Object.assign(new EventEmitter(), {
        write: () => undefined,
        setTimeout: () => undefined,
        destroy: (e?: Error) => e && req.emit("error", e),
        end: () => {
          const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: {}, destroy: vi.fn() });
          onResponse(res);
          m.respond?.(res);
        },
      });
      return req;
    },
  },
}));

import { MAX_RESPONSE_BYTES, postJson, publicLookup } from "../lib/net/safe-fetch";

beforeEach(() => {
  m.answers = [];
  m.lookupCalls = 0;
  m.requestOptions = null;
  m.respond = null;
});

const resolveVia = (host = "gw.example.com") =>
  new Promise<{ error: Error | null; addresses?: { address: string }[] }>((done) =>
    publicLookup(host, { all: true }, ((error: Error | null, addresses?: { address: string }[]) => done({ error, addresses })) as never),
  );

describe("the lookup the connection uses", () => {
  it("returns public addresses", async () => {
    m.answers = [[{ address: "93.184.216.34", family: 4 }]];
    expect((await resolveVia()).addresses?.[0].address).toBe("93.184.216.34");
  });

  it("refuses when the name resolves inward at connect time, whatever an earlier check saw", async () => {
    m.answers = [[{ address: "10.0.0.5", family: 4 }]];
    expect((await resolveVia()).error?.name).toBe("UnsafeUrlError");
  });

  it("refuses when any one of several answers is private", async () => {
    m.answers = [[{ address: "93.184.216.34", family: 4 }, { address: "::ffff:7f00:1", family: 6 }]];
    expect((await resolveVia()).error?.name).toBe("UnsafeUrlError");
  });
});

describe("postJson", () => {
  it("connects through the checking lookup and does not resolve the name any other way", async () => {
    m.respond = (res) => {
      res.emit("data", Buffer.from('{"ok":true}'));
      res.emit("end");
    };
    const result = await postJson("https://gw.example.com/v1", { a: "b" }, { x: 1 });
    expect(result.status).toBe(200);
    expect(result.text).toBe('{"ok":true}');
    expect(typeof m.requestOptions?.lookup).toBe("function");
    expect(m.lookupCalls).toBe(0); // nothing resolved until the socket asked
  });

  it("stops reading an answer larger than the cap", async () => {
    let destroyed = false;
    m.respond = (res) => {
      res.destroy = () => void (destroyed = true);
      res.emit("data", Buffer.alloc(MAX_RESPONSE_BYTES + 1));
    };
    await expect(postJson("https://gw.example.com/v1", {}, {})).rejects.toMatchObject({ name: "ResponseTooLargeError" });
    expect(destroyed).toBe(true);
  });

  it("refuses an address that is not public https before connecting", async () => {
    await expect(postJson("http://gw.example.com/v1", {}, {})).rejects.toMatchObject({ name: "UnsafeUrlError" });
    expect(m.requestOptions).toBeNull();
  });
});
