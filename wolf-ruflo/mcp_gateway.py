#!/usr/bin/env python3
"""Experimental local stdio gateway. Only agent_list can reach upstream.

This is not a KCT gateway, sandbox, network firewall, or Factory deployment.
Do not use for untrusted tenants or with production state.
"""
import json
import os
import selectors
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

LIMIT = 1024 * 1024

class Upstream:
    def __init__(self, cli, home):
        env = {'PATH': os.environ['PATH'], 'HOME': home, 'RUFLO_DAEMON_AUTOSTART': '0', 'CLAUDE_FLOW_MCP_TOOLS': 'agent_list', 'NO_COLOR': '1'}
        self.p = subprocess.Popen(['node', cli, 'mcp', 'start', '--tools', 'agent_list'], cwd=home, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
        self.sel = selectors.DefaultSelector()
        self.sel.register(self.p.stdout, selectors.EVENT_READ)
        self.buffer = b''
        self.counter = 0
    def request(self, method, params):
        self.counter += 1
        i = self.counter
        self.p.stdin.write((json.dumps({'jsonrpc':'2.0','id':i,'method':method,'params':params})+'\n').encode())
        self.p.stdin.flush()
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if b'\n' in self.buffer:
                line, self.buffer = self.buffer.split(b'\n', 1)
                obj = json.loads(line)
                if obj.get('id') == i:
                    if 'error' in obj: raise RuntimeError('upstream error')
                    return obj['result']
                continue
            if not self.sel.select(deadline-time.monotonic()): break
            chunk = os.read(self.p.stdout.fileno(), 65536)
            if not chunk: break
            self.buffer += chunk
            if len(self.buffer) > LIMIT: raise RuntimeError('upstream output too large')
        raise RuntimeError('upstream unavailable')
    def close(self):
        # Upstream and ordinary descendants are in their own process group.
        try: os.killpg(self.p.pid, signal.SIGTERM)
        except ProcessLookupError: pass
        try: self.p.wait(timeout=3)
        except subprocess.TimeoutExpired:
            try: os.killpg(self.p.pid, signal.SIGKILL)
            except ProcessLookupError: pass
            self.p.wait()
        self.sel.close()
        self.p.stdin.close(); self.p.stdout.close()

def serve(cli):
    with tempfile.TemporaryDirectory(prefix='wolf-mcp-gateway-') as home:
        u = Upstream(cli, home)
        try:
            initialized = False
            while True:
                line = sys.stdin.buffer.readline(LIMIT + 1)
                if not line: break
                if len(line) > LIMIT: raise ValueError('request too large')
                msg = None
                try:
                    msg = json.loads(line)
                    if not isinstance(msg, dict) or msg.get('jsonrpc') != '2.0': raise ValueError('invalid request')
                    method, request_id = msg.get('method'), msg.get('id')
                    if 'id' not in msg: continue  # notifications have no response
                    if method == 'initialize' and not initialized:
                        r = u.request('initialize', {'protocolVersion':'2024-11-05','capabilities':{},'clientInfo':{'name':'wolf-gateway','version':'1'}})
                        if r.get('protocolVersion') != '2024-11-05': raise RuntimeError('unsupported upstream protocol')
                        initialized = True
                        result = {'protocolVersion':'2024-11-05','serverInfo':{'name':'wolf-ruflo-readonly','version':'1'},'capabilities':{'tools':{}}}
                    elif not initialized:
                        raise ValueError('initialize required')
                    elif method == 'tools/list':
                        listing = u.request('tools/list', {})
                        matches = [x for x in listing.get('tools',[]) if x.get('name') == 'agent_list']
                        if len(matches) != 1: raise RuntimeError('missing upstream allowlisted tool')
                        result = {'tools':matches}
                    elif method == 'tools/call':
                        params = msg.get('params')
                        if not isinstance(params, dict) or params.get('name') != 'agent_list' or params.get('arguments', {}) != {}:
                            raise ValueError('tool or arguments denied')
                        result = u.request('tools/call', {'name':'agent_list','arguments':{}})
                    else:
                        raise ValueError('method denied')
                    response = {'jsonrpc':'2.0','id':request_id,'result':result}
                except (ValueError, TypeError, KeyError, json.JSONDecodeError):
                    response = {'jsonrpc':'2.0','id':msg.get('id') if isinstance(locals().get('msg'),dict) else None,'error':{'code':-32600,'message':'request denied'}}
                except (OSError, RuntimeError):
                    response = {'jsonrpc':'2.0','id':msg.get('id') if isinstance(locals().get('msg'),dict) else None,'error':{'code':-32000,'message':'upstream unavailable'}}
                sys.stdout.write(json.dumps(response, separators=(',',':'))+'\n'); sys.stdout.flush()
        finally: u.close()

if __name__ == '__main__':
    if len(sys.argv) != 2 or not Path(sys.argv[1]).is_absolute() or not Path(sys.argv[1]).is_file():
        raise SystemExit('usage: mcp_gateway.py /absolute/path/to/ruflo/bin/cli.js')
    def stop(signum, _frame):
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    serve(sys.argv[1])
