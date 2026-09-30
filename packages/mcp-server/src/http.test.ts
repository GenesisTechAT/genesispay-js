import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { AgentPaymentResult } from "@genesis-tech/genesispay-agent";
import type { AgentAccountInfo, AgentPaymentRecord } from "@genesis-tech/genesispay-agent";

import { afterEach, describe, expect, it, vi } from "vitest";

import { handleGenesisPayMcpHttpRequest } from "./http.js";
import type { AuthInfo, GenesisPayAgentLike } from "./http.js";
import { createGenesisPayMcpServer } from "./server.js";

// Lets one test add a probe tool to the per-request server, so it can read
// what the MCP request handlers actually receive as `extra.authInfo`. Every
// other test sees the real server unchanged.
const probe = vi.hoisted(() => ({
  onServer: undefined as ((server: McpServer) => void) | undefined,
}));

vi.mock("./server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server.js")>();
  return {
    ...actual,
    createGenesisPayMcpServer: (
      options: Parameters<typeof actual.createGenesisPayMcpServer>[0],
    ) => {
      const server = actual.createGenesisPayMcpServer(options);
      probe.onServer?.(server);
      return server;
    },
  };
});

const MCP_URL = "https://genesispay.example/mcp";
const ACCEPT_BOTH = "application/json, text/event-stream";

const accountInfo: AgentAccountInfo = {
  name: "research-bot",
  walletAddress: "0x2222222222222222222222222222222222222222",
  chainId: 84532,
  status: "active",
  usdcBalance: "12500000",
  policy: {
    perPaymentCapUsdcMinor: "1000000",
    dailyCapUsdcMinor: null,
    monthlyCapUsdcMinor: null,
    allowlistEnabled: false,
  },
  spentTodayUsdcMinor: "5000",
  spentThisMonthUsdcMinor: "20000",
};

function fakeAgent(): GenesisPayAgentLike & { accountCalls: number } {
  const agent = {
    accountCalls: 0,
    discover: async () => [],
    pay: async () => {
      throw new Error("pay is not expected in these tests");
    },
    paymentStatus: async () => {
      throw new Error("paymentStatus is not expected in these tests");
    },
    account: async () => {
      agent.accountCalls += 1;
      return accountInfo;
    },
  };
  return agent;
}

const settledPayment: AgentPaymentRecord = {
  id: "pay_mr306",
  agentAccountId: "acct_1",
  resourceUrl: "https://api.example.com/premium",
  description: null,
  destinationWallet: "0x1111111111111111111111111111111111111111",
  amountUsdcMinor: "5000",
  feeUsdcMinor: "0",
  chainId: 84532,
  status: "settled",
  txHash: `0x${"ab".repeat(32)}`,
  failureReason: null,
  approvalExpiresAt: null,
  resolvedAt: null,
  settledAt: "2026-09-25T12:00:00.000Z",
  createdAt: "2026-09-25T11:59:00.000Z",
};

function settledResult(): AgentPaymentResult {
  return new AgentPaymentResult({
    paymentId: settledPayment.id,
    status: "settled",
    payment: settledPayment,
    txHash: settledPayment.txHash,
    response: {
      status: 200,
      headers: { "content-type": "application/json" },
      bodyBase64: Buffer.from(JSON.stringify({ data: "premium" })).toString("base64"),
      mimeType: "application/json",
    },
  });
}

/** Deep search for an AbortSignal anywhere in what the tool handed the agent. */
function containsAbortSignal(value: unknown, seen = new Set<unknown>()): boolean {
  if (value instanceof AbortSignal) return true;
  if (typeof value !== "object" || value === null || seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).some(
    ([key, inner]) => key === "signal" || containsAbortSignal(inner, seen),
  );
}

const payCall = (id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: {
    name: "genesispay_pay",
    arguments: {
      idempotencyKey: "report-20260925-mr306",
      url: "https://api.example.com/premium",
    },
  },
});

function postJson(body: unknown): Request {
  return new Request(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: ACCEPT_BOTH },
    body: JSON.stringify(body),
  });
}

async function httpClient(
  agent: GenesisPayAgentLike,
  authInfo?: AuthInfo,
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    fetch: (url, init) =>
      handleGenesisPayMcpHttpRequest(new Request(url, init), { agent, authInfo }),
  });
  const client = new Client({ name: "http-test-client", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

async function stdioLikeClient(agent: GenesisPayAgentLike): Promise<Client> {
  const server = createGenesisPayMcpServer({ agent });
  const client = new Client({ name: "stdio-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const authInfo: AuthInfo = {
  token: "gp_oat_test_token",
  clientId: "client_123",
  scopes: ["genesispay:agent"],
  extra: { grantId: "grant_1" },
};

afterEach(() => {
  probe.onServer = undefined;
  vi.restoreAllMocks();
});

describe("handleGenesisPayMcpHttpRequest", () => {
  it("lists exactly the stdio server's tools (parity by construction)", async () => {
    const agent = fakeAgent();
    const overHttp = await httpClient(agent);
    const overStdio = await stdioLikeClient(agent);

    const httpTools = await overHttp.listTools();
    const stdioTools = await overStdio.listTools();

    expect(httpTools.tools.length).toBe(14);
    // The in-memory transport hands objects over by reference (keeping
    // `_meta: undefined`); HTTP serialises them. Compare the wire form.
    expect(httpTools).toStrictEqual(JSON.parse(JSON.stringify(stdioTools)));

    await Promise.all([overHttp.close(), overStdio.close()]);
  });

  it("annotates the read-only tools as read-only and genesispay_pay as destructive and idempotent", async () => {
    const client = await httpClient(fakeAgent());
    const { tools } = await client.listTools();
    const annotations = Object.fromEntries(
      tools.map((tool) => [tool.name, tool.annotations]),
    );

    for (const name of [
      "genesispay_account",
      "genesispay_discover",
      "genesispay_payment_status",
      "genesispay_result",
      "genesispay_shops",
      "genesispay_trending",
    ]) {
      expect(annotations[name]).toEqual({ readOnlyHint: true, openWorldHint: false });
    }
    expect(annotations.genesispay_pay).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });

    await client.close();
  });

  it("serves independent JSON requests without a session: initialize, then two tools/call", async () => {
    const agent = fakeAgent();

    const init = await handleGenesisPayMcpHttpRequest(
      postJson({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "raw-client", version: "0.0.0" },
        },
      }),
      { agent },
    );
    expect(init.status).toBe(200);
    expect(init.headers.get("content-type")).toContain("application/json");
    expect(init.headers.get("mcp-session-id")).toBeNull();
    const initBody = (await init.json()) as {
      id: number;
      result: { serverInfo: { name: string } };
    };
    expect(initBody.id).toBe(1);
    expect(initBody.result.serverInfo.name).toBeTruthy();

    // Each call is a fresh server and transport: no session header, no
    // initialize on the same instance, and each still answers.
    for (const id of [2, 3]) {
      const response = await handleGenesisPayMcpHttpRequest(
        postJson({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "genesispay_account", arguments: {} },
        }),
        { agent },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      const body = (await response.json()) as {
        id: number;
        result: { isError?: boolean; content: Array<{ type: string; text: string }> };
      };
      expect(body.id).toBe(id);
      expect(body.result.isError).toBeFalsy();
      expect(body.result.content[0].text).toContain("research-bot");
    }

    expect(agent.accountCalls).toBe(2);
  });

  it("passes authInfo to the transport and on to the request handlers", async () => {
    const handleRequest = vi.spyOn(
      WebStandardStreamableHTTPServerTransport.prototype,
      "handleRequest",
    );
    let seen: unknown = "not called";
    probe.onServer = (server) => {
      server.registerTool(
        "probe_auth",
        { description: "test probe", inputSchema: {} },
        async (_args, extra) => {
          seen = extra.authInfo;
          return { content: [{ type: "text", text: "ok" }] };
        },
      );
    };

    const response = await handleGenesisPayMcpHttpRequest(
      postJson({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "probe_auth", arguments: {} },
      }),
      { agent: fakeAgent(), authInfo },
    );

    expect(response.status).toBe(200);
    expect(handleRequest).toHaveBeenCalledTimes(1);
    expect(handleRequest.mock.calls[0][1]).toEqual({ authInfo });
    expect(seen).toEqual(authInfo);
  });

  it.each(["GET", "DELETE", "PUT"])("answers %s with 405 and Allow: POST", async (method) => {
    const response = await handleGenesisPayMcpHttpRequest(
      new Request(MCP_URL, { method, headers: { accept: ACCEPT_BOTH } }),
      { agent: fakeAgent() },
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    const body = (await response.json()) as { jsonrpc: string; error: { code: number } };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error.code).toBe(-32000);
  });

  it("answers a malformed JSON body with a -32700 parse error and does not throw", async () => {
    const response = await handleGenesisPayMcpHttpRequest(
      new Request(MCP_URL, {
        method: "POST",
        headers: { "content-type": "application/json", accept: ACCEPT_BOTH },
        body: "{not json",
      }),
      { agent: fakeAgent() },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });
  it("MR-306: an aborted request.signal does not abort genesispay_pay", async () => {
    const payArgs: unknown[][] = [];
    let payCompleted = false;
    const agent: GenesisPayAgentLike = {
      ...fakeAgent(),
      pay: async (...args) => {
        payArgs.push(args);
        await new Promise((resolve) => setTimeout(resolve, 50));
        payCompleted = true;
        return settledResult();
      },
    };
    const controller = new AbortController();
    const request = new Request(MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: ACCEPT_BOTH },
      body: JSON.stringify(payCall(11)),
      signal: controller.signal,
    });

    const pending = handleGenesisPayMcpHttpRequest(request, { agent });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(payArgs).toHaveLength(1);
    expect(payCompleted).toBe(false);
    controller.abort();
    expect(request.signal.aborted).toBe(true);

    const response = await pending;

    expect(payCompleted).toBe(true);
    expect(containsAbortSignal(payArgs[0])).toBe(false);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      id: number;
      result: { isError?: boolean; content: Array<{ type: string; text: string }> };
    };
    expect(body.id).toBe(11);
    expect(body.result.isError).toBeFalsy();
    expect(body.result.content[0].text).toContain("pay_mr306");
    expect(body.result.content[0].text).toContain("settled");
  });

  it("refuses a JSON-RPC batch with -32600 before any tool runs (tools/call + notifications/cancelled)", async () => {
    const handleRequest = vi.spyOn(
      WebStandardStreamableHTTPServerTransport.prototype,
      "handleRequest",
    );
    const pay = vi.fn(async () => settledResult());
    const agent: GenesisPayAgentLike = { ...fakeAgent(), pay };

    const response = await handleGenesisPayMcpHttpRequest(
      postJson([
        payCall(21),
        {
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: 21, reason: "client gave up" },
        },
      ]),
      { agent },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      jsonrpc: string;
      id: null;
      error: { code: number; message: string };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBeNull();
    expect(body.error.code).toBe(-32600);
    expect(body.error.message).toMatch(/batch/i);
    expect(pay).not.toHaveBeenCalled();
    expect(handleRequest).not.toHaveBeenCalled();
  });

  it("refuses a single-element batch too", async () => {
    const pay = vi.fn(async () => settledResult());
    const response = await handleGenesisPayMcpHttpRequest(postJson([payCall(22)]), {
      agent: { ...fakeAgent(), pay },
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32600);
    expect(pay).not.toHaveBeenCalled();
  });

  it("acknowledges a lone notifications/cancelled with 202 without reaching the transport", async () => {
    const handleRequest = vi.spyOn(
      WebStandardStreamableHTTPServerTransport.prototype,
      "handleRequest",
    );

    const response = await handleGenesisPayMcpHttpRequest(
      postJson({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 1 },
      }),
      { agent: fakeAgent() },
    );

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
    expect(handleRequest).not.toHaveBeenCalled();
  });
});
