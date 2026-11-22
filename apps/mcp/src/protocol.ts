/**
 * Minimal Model Context Protocol server logic over newline-delimited JSON-RPC (stdio transport).
 * It is a thin proxy: the tool list and every rule live in the local QA Virtual Office server, which
 * authenticates this process with the agent token. Nothing is decided here.
 */
export const SERVER_NAME = 'qa-office';
export const SERVER_VERSION = '0.1.0';
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface ProxyResult {
  ok: boolean;
  status: number;
  body: unknown;
}
export interface Backend {
  listTools: () => Promise<ProxyResult>;
  callTool: (name: string, args: unknown) => Promise<ProxyResult>;
}

type Json = Record<string, unknown>;
interface Request {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Json;
}

const INSTRUCTIONS =
  'QA Virtual Office. You work as a QA assistant with limited rights: you can read QA data and create drafts ' +
  '(requirements, test cases, defect reports, tasks, notes). You can never approve a test case, mark a test passed, ' +
  'close a defect or complete a task: a person decides. Use fake or masked test data only. Start with qa_list_projects.';

const rpcError = (id: Request['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const rpcResult = (id: Request['id'], result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result });

const messageOf = (body: unknown, status: number): string => {
  const b = body as { error?: unknown; message?: unknown } | null;
  const code = typeof b?.error === 'string' ? b.error : `http_${status}`;
  const msg = typeof b?.message === 'string' ? b.message : '';
  return msg ? `${code}: ${msg}` : code;
};

/** Handles one JSON-RPC message; returns the response, or null for notifications. */
export async function handleMessage(msg: unknown, backend: Backend): Promise<unknown | null> {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return rpcError(null, -32600, 'Invalid request');
  const req = msg as Request;
  const isNotification = req.id === undefined;
  const method = req.method;
  if (typeof method !== 'string') return isNotification ? null : rpcError(req.id, -32600, 'Invalid request');
  if (isNotification) return null; // notifications/initialized, notifications/cancelled, ...

  switch (method) {
    case 'initialize': {
      const wanted = typeof req.params?.protocolVersion === 'string' ? req.params.protocolVersion : '';
      const protocolVersion = (SUPPORTED_VERSIONS as readonly string[]).includes(wanted) ? wanted : SUPPORTED_VERSIONS[0];
      return rpcResult(req.id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }, instructions: INSTRUCTIONS });
    }
    case 'ping':
      return rpcResult(req.id, {});
    case 'tools/list': {
      const r = await backend.listTools();
      if (!r.ok) return rpcError(req.id, -32000, messageOf(r.body, r.status));
      return rpcResult(req.id, { tools: (r.body as { tools?: ToolDescriptor[] }).tools ?? [] });
    }
    case 'tools/call': {
      const name = req.params?.name;
      if (typeof name !== 'string' || !/^[a-z0-9_]{1,60}$/.test(name)) return rpcError(req.id, -32602, 'Invalid tool name');
      const r = await backend.callTool(name, req.params?.arguments ?? {});
      if (!r.ok) return rpcResult(req.id, { content: [{ type: 'text', text: messageOf(r.body, r.status) }], isError: true });
      return rpcResult(req.id, { content: [{ type: 'text', text: JSON.stringify((r.body as { result?: unknown }).result ?? null) }], isError: false });
    }
    case 'resources/list':
      return rpcResult(req.id, { resources: [] });
    case 'prompts/list':
      return rpcResult(req.id, { prompts: [] });
    default:
      return rpcError(req.id, -32601, `Method not found: ${method}`);
  }
}
