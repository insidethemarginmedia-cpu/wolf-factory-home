import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import json
import selectors

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'wolf-ruflo'))
import memory
from ruflo_memory import WolfContextStore
from worker_contract import prepare

class ContractTests(unittest.TestCase):
    def setUp(self):
        self.req = dict(mission='m',operation='op',workflow='dbos-1',worker='cezar',provider='flint',fence=2)
        self.claims = self.req | dict(admitted=True,lease_current=True,lease_expires_at=200,eur_spend=0,cost_known=True,paid_fallback=False,trial_credit=False,external_effect='not_started')
    def go(self, changes=None, request=None):
        return prepare(request or self.req, lambda _: self.claims | (changes or {}), 100)
    def test_targets_and_authority_identity(self):
        self.assertEqual(self.go().fence,2)
        for worker in ('cezar','opencode','openhands','qwen-code'):
            req = self.req | {'worker':worker}; self.assertEqual(prepare(req,lambda _: self.claims | {'worker':worker},100).worker,worker)
        with self.assertRaises(PermissionError): self.go(request=self.req | {'worker':'jules'})
        with self.assertRaises(PermissionError): self.go({'fence':1})
        with self.assertRaises(PermissionError): self.go({'mission':'other'})
        with self.assertRaises(PermissionError): prepare(self.req,None,100)
        with self.assertRaises(PermissionError): prepare(self.req,lambda _: (_ for _ in ()).throw(RuntimeError()),100)
    def test_fail_closed_recovery_and_economics(self):
        for k, v in [('admitted',False),('lease_current',False),('lease_expires_at',100),('external_effect','unknown'),('external_effect','receipted'),('cost_known',False),('eur_spend',1),('eur_spend',False),('paid_fallback',True),('trial_credit',True)]:
            with self.subTest(k=k,v=v), self.assertRaises(PermissionError): self.go({k:v})
    def test_memory_entry_bridge(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d,'db'); memory.initialize(path); store=WolfContextStore(path)
            entry = {'id':'one','key':'context','namespace':'m','content':'safe', 'embedding':[1,2], 'type':'semantic','tags':[],'metadata':{}}
            self.assertEqual(store.store('m','op',3,entry),'stored')
            self.assertEqual(store.store('m','op',3,entry),'duplicate')
            self.assertEqual(store.get_by_key('m','context'),entry)
            self.assertIsNone(store.get_by_key('other','context'))
            with self.assertRaises(ValueError): store.store('other','op',3,entry)

class GatewayTests(unittest.TestCase):
    @unittest.skipUnless(os.environ.get('WOLF_RUFLO_CLI'), 'set WOLF_RUFLO_CLI to test real upstream gateway')
    def test_real_server_allowlist_lifecycle_and_no_secret(self):
        cli = os.environ['WOLF_RUFLO_CLI']
        def daemons():
            lines = subprocess.check_output(['ps','-eo','args'],text=True).splitlines()
            return {line.strip() for line in lines if 'daemon start --foreground' in line and 'wolf-mcp-gateway-' in line and 'node ' in line}
        before = daemons()
        for iteration in range(2):
            env = dict(os.environ, WOLF_SECRET_CANARY='CANARY_DO_NOT_FORWARD_76f6')
            p = subprocess.Popen([sys.executable,str(ROOT/'wolf-ruflo/mcp_gateway.py'),cli],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1,env=env)
            sel = selectors.DefaultSelector(); sel.register(p.stdout,selectors.EVENT_READ)
            def req(i, method, params):
                p.stdin.write(json.dumps({'jsonrpc':'2.0','id':i,'method':method,'params':params})+'\n');p.stdin.flush()
                self.assertTrue(sel.select(20),'gateway timed out')
                return json.loads(p.stdout.readline())
            try:
                self.assertEqual(req(1,'initialize',{})['result']['protocolVersion'],'2024-11-05')
                self.assertEqual([x['name'] for x in req(2,'tools/list',{})['result']['tools']],['agent_list'])
                self.assertFalse(req(3,'tools/call',{'name':'agent_list','arguments':{}})['result']['isError'])
                self.assertIn('error',req(4,'tools/call',{'name':'agent_spawn','arguments':{}}))
                self.assertIn('error',req(5,'tools/call',{'name':'memory_store','arguments':{}}))
                self.assertIn('error',req(6,'tools/call',{'name':'agent_list','arguments':{'foo':'bar'}}))
                self.assertIn('error',req(7,'unknown/mission',{}))
            finally:
                p.stdin.close(); p.wait(timeout=10); out=p.stdout.read(); err=p.stderr.read();p.stdout.close();p.stderr.close();sel.close()
            self.assertEqual(p.returncode,0)
            self.assertNotIn('CANARY_DO_NOT_FORWARD_76f6',out+err)
        # Forced gateway termination must also reap its upstream child.
        p = subprocess.Popen([sys.executable,str(ROOT/'wolf-ruflo/mcp_gateway.py'),cli],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        sel = selectors.DefaultSelector(); sel.register(p.stdout,selectors.EVENT_READ)
        try:
            p.stdin.write(json.dumps({'jsonrpc':'2.0','id':1,'method':'initialize','params':{}})+'\n'); p.stdin.flush()
            self.assertTrue(sel.select(20)); self.assertIn('result',json.loads(p.stdout.readline()))
            children = subprocess.check_output(['pgrep','-P',str(p.pid)],text=True).split()
            self.assertTrue(children)
            p.terminate(); p.wait(timeout=10)
            for child in children: self.assertFalse(Path('/proc/'+child).exists(), 'upstream child leaked')
        finally:
            if p.poll() is None: p.kill(); p.wait()
            p.stdin.close();p.stdout.close();p.stderr.close();sel.close()
        self.assertEqual(daemons(),before)

if __name__ == '__main__': unittest.main()
