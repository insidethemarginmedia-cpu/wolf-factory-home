#!/usr/bin/env node
/**
 * Wolf-owned stdio proxy for the Ruflo MCP server.
 *
 * Why: Ruflo's CLAUDE_FLOW_MCP_TOOLS selector only reduces the advertised
 * tools/list; a non-advertised registered tool still executes on tools/call
 * (see tests/mcp-safety.test.mjs 5c/5d). This proxy enforces the allowlist at
 * both points, so the Wolf allowlist is the enforcement point, not a hint.
 *
 * It is a pure pass-through otherwise: no retries, no timers, no scheduling,
 * no mission admission. It does not read or log environment secrets.
 *
 * Usage: node adapter/mcp-allowlist-proxy.mjs <ruflo-cli.js> <allowlist.json>
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [cliPath, allowPath] = process.argv.slice(2);
if (!cliPath || !allowPath) {
  process.stderr.write('usage: mcp-allowlist-proxy.mjs <ruflo-cli.js> <allowlist.json>\n');
  process.exit(64);
}
const allowed = new Set(JSON.parse(readFileSync(allowPath, 'utf8')).tools);

// The child gets the allowlist selector and autostart disabled (no detached daemon).
const child = spawn(process.execPath, [cliPath, 'mcp', 'start'], {
  env: { ...process.env, CLAUDE_FLOW_MCP_TOOLS: [...allowed].join(','), RUFLO_DAEMON_AUTOSTART: '0' },
  stdio: ['pipe', 'pipe', 'inherit'],
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

const pending = new Map(); // upstream request id -> method

function reply(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { child.stdin.write(line + '\n'); return; }
  if (msg.method === 'tools/call') {
    const name = msg.params?.name;
    if (!allowed.has(name)) {
      reply({ jsonrpc: '2.0', id: msg.id, result: {
        content: [{ type: 'text', text: `refused: tool "${name}" is not in the Wolf MCP allowlist` }],
        isError: true,
      } });
      return;
    }
  }
  if (msg.id !== undefined && msg.method) pending.set(msg.id, msg.method);
  child.stdin.write(JSON.stringify(msg) + '\n');
});

createInterface({ input: child.stdout }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { process.stdout.write(line + '\n'); return; }
  if (pending.get(msg.id) === 'tools/list' && Array.isArray(msg.result?.tools)) {
    msg.result.tools = msg.result.tools.filter((t) => allowed.has(t.name));
  }
  pending.delete(msg.id);
  process.stdout.write(JSON.stringify(msg) + '\n');
});

process.stdin.on('end', () => child.stdin.end());
