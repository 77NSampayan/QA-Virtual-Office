import { describe, expect, it } from 'vitest';
import { handleMessage, type Backend, type ProxyResult } from '../src/protocol.ts';

const fake = (over: Partial<Backend> = {}): Backend => ({
  listTools: async () => ({ ok: true, status: 200, body: { tools: [{ name: 'qa_list_projects', description: 'd', inputSchema: { type: 'object' } }] } }),
  callTool: async (name, args) => ({ ok: true, status: 200, body: { result: { name, args } } }),
  ...over,
});
const call = (msg: unknown, backend = fake()) => handleMessage(msg, backend) as Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string }; id: unknown } | null>;

describe('MCP protocol', () => {
  it('initialize negotiates a supported protocol version and announces tools only', async () => {
    const r = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'c', version: '1' } } });
    expect(r!.id).toBe(1);
    expect(r!.result).toMatchObject({ protocolVersion: '2025-03-26', serverInfo: { name: 'qa-office' } });
    expect(Object.keys((r!.result as { capabilities: object }).capabilities)).toEqual(['tools']);
    expect(String((r!.result as { instructions: string }).instructions)).toContain('never approve');
    const unknown = await call({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    expect(unknown!.result).toMatchObject({ protocolVersion: '2025-06-18' });
  });

  it('a launched agent gets its playbook as the instructions; the shared token or a failure keeps the generic ones', async () => {
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } };
    const named = await call(init, fake({ whoami: async () => ({ ok: true, status: 200, body: { attributed: true, instructions: 'You are Quinn, the Test Case Writer.' } }) }));
    expect((named!.result as { instructions: string }).instructions).toBe('You are Quinn, the Test Case Writer.');
    const shared = await call(init, fake({ whoami: async () => ({ ok: true, status: 200, body: { attributed: false } }) }));
    expect((shared!.result as { instructions: string }).instructions).toContain('never approve');
    const down = await call(init, fake({ whoami: async () => ({ ok: false, status: 0, body: { error: 'server_unreachable' } }) }));
    expect((down!.result as { instructions: string }).instructions).toContain('never approve');
    const boom = await call(init, fake({ whoami: async () => { throw new Error('x'); } }));
    expect((boom!.result as { instructions: string }).instructions).toContain('never approve');
    const huge = await call(init, fake({ whoami: async () => ({ ok: true, status: 200, body: { attributed: true, instructions: 'x'.repeat(20_000) } }) }));
    expect((huge!.result as { instructions: string }).instructions.length).toBeLessThanOrEqual(8_000);
  });

  it('notifications get no response; ping works; unknown methods are errors', async () => {
    expect(await call({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect((await call({ jsonrpc: '2.0', id: 3, method: 'ping' }))!.result).toEqual({});
    expect((await call({ jsonrpc: '2.0', id: 4, method: 'resources/read' }))!.error?.code).toBe(-32601);
    expect((await call({ jsonrpc: '2.0', id: 5, method: 'tools/list' }))!.result).toMatchObject({ tools: [{ name: 'qa_list_projects' }] });
    expect((await call([1, 2]))!.error?.code).toBe(-32600);
    expect((await call('nope'))!.error?.code).toBe(-32600);
  });

  it('tools/list failures (access off, app not running) surface as one clear error', async () => {
    const off: ProxyResult = { ok: false, status: 403, body: { error: 'agent_access_disabled', message: 'Agent access is turned off.' } };
    const r = await call({ jsonrpc: '2.0', id: 6, method: 'tools/list' }, fake({ listTools: async () => off }));
    expect(r!.error).toMatchObject({ code: -32000 });
    expect(r!.error!.message).toContain('agent_access_disabled');
  });

  it('tools/call passes arguments through and wraps results; server refusals become isError results (not crashes)', async () => {
    const good = await call({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'qa_get_summary', arguments: { project: 'Demo' } } });
    expect(good!.result).toMatchObject({ isError: false });
    expect(JSON.parse(((good!.result as { content: Array<{ text: string }> }).content[0]!).text)).toEqual({ name: 'qa_get_summary', args: { project: 'Demo' } });
    const refused = await call(
      { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'qa_move_task', arguments: {} } },
      fake({ callTool: async () => ({ ok: false, status: 403, body: { error: 'human_required', message: 'Only a person can do this' } }) }),
    );
    expect(refused!.result).toMatchObject({ isError: true });
    expect((refused!.result as { content: Array<{ text: string }> }).content[0]!.text).toBe('human_required: Only a person can do this');
  });

  it('rejects odd tool names before anything is sent', async () => {
    let called = false;
    const spy = fake({ callTool: async () => ((called = true), { ok: true, status: 200, body: {} }) });
    for (const name of ['../../api/hooks', 'QA_UPPER', '', 5, 'a b']) {
      expect((await call({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name } }, spy))!.error?.code, String(name)).toBe(-32602);
    }
    expect(called).toBe(false);
  });
});
