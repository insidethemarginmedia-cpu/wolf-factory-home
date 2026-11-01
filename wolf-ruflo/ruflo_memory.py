"""SQLite-backed Wolf context bridge for the subset of Ruflo MemoryEntry used here.

Not an IMemoryBackend implementation and not plugged into upstream Ruflo.
The trusted host must authorize each call; namespaces alone are not access control.
"""
import memory

class WolfContextStore:
    def __init__(self, path): self.path = path
    def store(self, mission, operation, fence, entry):
        if not isinstance(entry, dict) or entry.get('namespace') != mission:
            raise ValueError('mission namespace mismatch')
        if not isinstance(entry.get('content'), str): raise ValueError('content required')
        # Persist the entire JSON record, including optional embedding arrays.
        return memory.put(self.path, mission, operation, entry.get('key'), entry, fence)
    def get_by_key(self, mission, key):
        return memory.get(self.path, mission, key)
