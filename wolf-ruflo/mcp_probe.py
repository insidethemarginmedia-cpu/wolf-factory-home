"""Disposable discovery probe only; not an MCP gateway or access-control layer."""
import json
import os
import selectors
import subprocess
import sys
import tempfile
import time
from pathlib import Path

if len(sys.argv) != 2 or not Path(sys.argv[1]).is_absolute():
    raise SystemExit('usage: python3 mcp_probe.py /absolute/path/to/ruflo/bin/cli.js')
with tempfile.TemporaryDirectory(prefix='wolf-ruflo-mcp-') as home:
    env = {'PATH': os.environ['PATH'], 'HOME': home, 'RUFLO_DAEMON_AUTOSTART': '0', 'CLAUDE_FLOW_MCP_TOOLS': 'agent_list', 'NO_COLOR': '1'}
    # No inherited provider keys. No network isolation is implied by this script.
    with tempfile.TemporaryFile(mode='w+') as stderr:
        p = subprocess.Popen(['node', sys.argv[1], 'mcp', 'start', '--tools', 'agent_list'], cwd=home, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, text=True, bufsize=1)
        selector = selectors.DefaultSelector()
        selector.register(p.stdout, selectors.EVENT_READ)
        def request(i, method, params):
            p.stdin.write(json.dumps({'jsonrpc':'2.0','id':i,'method':method,'params':params})+'\n'); p.stdin.flush()
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                if not selector.select(deadline-time.monotonic()): break
                line = p.stdout.readline()
                if not line: break
                reply = json.loads(line)
                if reply.get('id') == i: return reply
            raise RuntimeError('MCP response timeout or server exited')
        try:
            hello = request(1, 'initialize', {'protocolVersion':'2024-11-05','capabilities':{},'clientInfo':{'name':'wolf-probe','version':'1'}})
            if 'error' in hello or hello.get('result', {}).get('protocolVersion') != '2024-11-05': raise RuntimeError('initialize failed')
            listing = request(2, 'tools/list', {})
            if [x['name'] for x in listing.get('result', {}).get('tools', [])] != ['agent_list']: raise RuntimeError('unexpected tool list')
            result = request(3, 'tools/call', {'name':'agent_list','arguments':{}})
            if 'error' in result or result.get('result', {}).get('isError') is not False: raise RuntimeError('tool failed')
            print(json.dumps({'initialize':'PASS', 'tools':['agent_list'], 'call':result['result']}))
        finally:
            p.terminate()
            try: p.wait(timeout=3)
            except subprocess.TimeoutExpired: p.kill(); p.wait()
            selector.close()
