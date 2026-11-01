import concurrent.futures
import importlib.util
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'wolf-ruflo'))
import memory
import guard

class MemoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.tmp.name) / 'store.sqlite')
        memory.initialize(self.db)
    def tearDown(self): self.tmp.cleanup()
    def test_restart_and_isolation(self):
        memory.put(self.db, 'm1', 'op1', 'key', {'v':[1,2]}, 1)
        script = "import memory,sys,json; print(json.dumps(memory.get(sys.argv[1],'m1','key')))"
        env = dict(os.environ, PYTHONPATH=str(ROOT / 'wolf-ruflo'))
        result = subprocess.check_output([sys.executable, '-c', script, self.db], env=env, text=True)
        self.assertEqual(result.strip(), '{"v": [1, 2]}')
        self.assertIsNone(memory.get(self.db, 'm2', 'key'))
    def test_duplicate_stale_and_conflict(self):
        self.assertEqual(memory.put(self.db, 'm', 'op', 'k', 'v', 2), 'stored')
        self.assertEqual(memory.put(self.db, 'm', 'op', 'k', 'v', 3), 'duplicate')
        with self.assertRaises(ValueError): memory.put(self.db, 'm', 'op', 'k', 'changed', 3)
        with self.assertRaises(ValueError): memory.put(self.db, 'm', 'new', 'k', 'bad', 2)
        self.assertEqual(memory.get(self.db, 'm', 'k'), 'v')
    def test_lost_response_after_commit_and_snapshot_restore(self):
        env = dict(os.environ, PYTHONPATH=str(ROOT / 'wolf-ruflo'))
        code = "import memory,sys,os; memory.put(sys.argv[1],'m','operation','k',{'v':7},1); os._exit(0)"
        subprocess.check_call([sys.executable,'-c',code,self.db],env=env)
        self.assertEqual(memory.put(self.db,'m','operation','k',{'v':7},1), 'duplicate')
        backup=self.db+'.backup'; recovered=self.db+'.restored'
        memory.backup(self.db,backup)
        memory.recover_copy(backup,recovered)
        Path(self.db).write_bytes(b'corrupt')
        self.assertEqual(memory.get(recovered,'m','k'),{'v':7})
        self.assertEqual(Path(self.db).read_bytes(),b'corrupt')
    def test_concurrent_processes(self):
        env = dict(os.environ, PYTHONPATH=str(ROOT / 'wolf-ruflo'))
        script = "import memory,sys; memory.put(sys.argv[1], 'm', sys.argv[2], sys.argv[2], sys.argv[2], 4)"
        procs = [subprocess.Popen([sys.executable, '-c', script, self.db, 'op'+str(i)], env=env) for i in range(12)]
        self.assertTrue(all(p.wait() == 0 for p in procs))
        for i in range(12): self.assertEqual(memory.get(self.db, 'm', 'op'+str(i)), 'op'+str(i))
    def test_process_killed_during_uncommitted_write(self):
        memory.put(self.db, 'm', 'op', 'k', 'original', 1)
        script = "import sqlite3,sys,os; c=sqlite3.connect(sys.argv[1]); c.execute('BEGIN IMMEDIATE'); c.execute(\"UPDATE entries SET value='garbage'\"); os._exit(0)"
        subprocess.check_call([sys.executable, '-c', script, self.db])
        self.assertEqual(memory.get(self.db, 'm', 'k'), 'original')
    def test_hot_journal_recovers_on_copy_only(self):
        for i in range(10): memory.put(self.db, 'm', f'o{i}', f'k{i}', 'A' * 500000, 1)
        script = """import sqlite3,sys,os
c=sqlite3.connect(sys.argv[1]); c.execute('PRAGMA cache_size=5'); c.execute('BEGIN IMMEDIATE')
for i in range(10): c.execute('UPDATE entries SET value=? WHERE key=?', ('B'*500000, 'k'+str(i)))
os._exit(0)
"""
        subprocess.check_call([sys.executable, '-c', script, self.db])
        journal = Path(self.db + '-journal'); self.assertTrue(journal.exists())
        before = Path(self.db).read_bytes(); before_journal = journal.read_bytes()
        target = self.db + '.recovered'
        memory.recover_copy(self.db, target)
        self.assertEqual(memory.get(target,'m','k0'),'A'*500000)
        self.assertEqual(Path(self.db).read_bytes(), before)
        self.assertEqual(journal.read_bytes(), before_journal)
        with self.assertRaises(FileExistsError): memory.recover_copy(self.db, target)
    def test_backup_and_incompatible_corruption(self):
        memory.put(self.db, 'm', 'o', 'k', 42, 1)
        target = self.db + '.backup'
        memory.backup(self.db, target)
        self.assertEqual(memory.get(target, 'm', 'k'), 42)
        with self.assertRaises(FileExistsError): memory.backup(self.db, target)
        con = sqlite3.connect(self.db); con.execute('UPDATE metadata SET version=2'); con.commit(); con.close()
        before = Path(self.db).read_bytes()
        with self.assertRaises(ValueError): memory.put(self.db, 'm', 'x', 'k', 9, 1)
        self.assertEqual(before, Path(self.db).read_bytes())
        Path(self.db).write_bytes(b'corrupt data')
        with self.assertRaises(sqlite3.DatabaseError): memory.put(self.db, 'm', 'x', 'k', 9, 1)
        self.assertEqual(Path(self.db).read_bytes(), b'corrupt data')
    def test_wal_files_fail_closed(self):
        wal = Path(self.db + '-wal'); wal.write_bytes(b'unchanged')
        with self.assertRaises(ValueError): memory.get(self.db, 'm', 'key')
        with self.assertRaises(ValueError): memory.recover_copy(self.db, self.db + '.copy')
        self.assertEqual(wal.read_bytes(), b'unchanged')
        wal.unlink()
        conn = sqlite3.connect(self.db); self.assertEqual(conn.execute('PRAGMA journal_mode=WAL').fetchone(), ('wal',)); conn.close()
        with self.assertRaises(ValueError): memory.get(self.db, 'm', 'key')
        with self.assertRaises(ValueError): memory.recover_copy(self.db, self.db + '.copy2')
    def test_no_overwrite_and_input(self):
        with self.assertRaises(FileExistsError): memory.initialize(self.db)
        for bad in ['../x', '', 'x/y']:
            with self.assertRaises(ValueError): memory.put(self.db, bad, 'op', 'key', 1, 1)
        self.assertEqual(os.stat(self.db).st_mode & 0o777, 0o600)

class GuardTests(unittest.TestCase):
    def test_guards(self):
        valid = dict(worker='cezar', authorized=True, current_lease=True, spend_eur=0, cost_known=True, paid_fallback=False, trial_credit=False, external_result='not_started')
        self.assertTrue(guard.validate_context(**valid))
        for key, value in [('worker', 'jules'), ('authorized', False), ('current_lease', False), ('spend_eur', 1), ('cost_known', False), ('paid_fallback', True), ('trial_credit', True), ('external_result', 'unknown')]:
            with self.subTest(key=key), self.assertRaises(PermissionError): guard.validate_context(**(valid | {key:value}))

if __name__ == '__main__': unittest.main()
