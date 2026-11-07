#!/usr/bin/env node
/**
 * The memory tools for the agent: remember, recall, forget (server/memory.mjs owns the file format).
 *
 *   node memory-mcp.mjs <memory.json>
 *
 * Model Context Protocol over stdio (newline-delimited JSON-RPC), like custom-tools-mcp.mjs. The approval gate lets these run without a
 * question: they only change the person's memory list, which they see and edit in Settings -> Memory.
 */
import { createInterface } from 'node:readline';
import { addMemory, readMemory, writeMemory } from '../memory.mjs';

const file = process.argv[2];
if (!file) { console.error('usage: memory-mcp.mjs <memory.json>'); process.exit(2); }

const TOOLS = [
  { name: 'remember', description: 'Save one short, lasting fact about the person or their preferences for future chats (for example: "Prefers metric units", "Works on the Strata project in ~/Apps/Strata"). Only when they ask you to remember something or clearly state something lasting. Never secrets.', inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'The fact, in one sentence.' } }, required: ['text'], additionalProperties: false } },
  { name: 'recall', description: 'List everything saved in memory, with ids.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'forget', description: 'Delete one memory by its id (the [id] in the memory list).', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } },
];

function call(name, args = {}) {
  if (name === 'remember') { const item = addMemory(file, args.text, 'assistant'); return `Saved [${item.id}]: ${item.text}`; }
  if (name === 'recall') { const items = readMemory(file); return items.length ? items.map(i => `[${i.id}] ${i.text}`).join('\n') : 'Memory is empty.'; }
  if (name === 'forget') {
    const items = readMemory(file);
    const hit = items.find(i => i.id === String(args.id ?? '').replace(/[[\]]/g, '').trim());
    if (!hit) return 'No memory has that id. Use recall to see the ids.';
    writeMemory(file, items.filter(i => i !== hit));
    return `Forgot: ${hit.text}`;
  }
  throw new Error(`Unknown tool ${name}`);
}

const send = msg => process.stdout.write(`${JSON.stringify(msg)}\n`);
createInterface({ input: process.stdin }).on('close', () => process.exit(0)).on('line', line => {
  let req; try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  if (id === undefined) return;
  try {
    if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'strata-memory', version: '1.0.0' } } });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      try { return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: call(params?.name, params?.arguments) }] } }); }
      catch (e) { return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: e.message }] } }); }
    }
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method ${method}` } });
  } catch (e) { send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } }); }
});
