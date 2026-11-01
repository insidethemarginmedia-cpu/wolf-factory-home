"""Pure, non-executing contract for a future existing-Factory adapter.

Only a trusted host may provide the authority callback. The callback must verify
KCT/DBOS state atomically at the actual dispatch boundary. This module neither
executes a worker nor authorizes external effects or publication.
"""
import re
import math
from dataclasses import dataclass

ID = re.compile(r'^[A-Za-z0-9_-]{1,128}$')
WORKERS = frozenset(('cezar', 'opencode', 'openhands', 'qwen-code'))
PROVIDERS = frozenset(('groq', 'flint', 'ollama'))

@dataclass(frozen=True)
class Context:
    mission: str
    operation: str
    worker: str
    provider: str
    fence: int
    workflow: str

def prepare(request, authority, now):
    if not callable(authority) or not isinstance(request, dict): raise PermissionError('authority required')
    for field in ('mission', 'operation', 'workflow'):
        if not isinstance(request.get(field), str) or not ID.fullmatch(request[field]): raise PermissionError('identity denied')
    if request.get('worker') not in WORKERS or request.get('provider') not in PROVIDERS: raise PermissionError('worker or provider denied')
    fence = request.get('fence')
    if type(fence) is not int or fence < 1: raise PermissionError('fence denied')
    # A trusted integration must obtain these claims from the real authorities,
    # not from caller-supplied JSON. Fail closed on callback errors or bad types.
    try: claims = authority(request.copy())
    except Exception as exc: raise PermissionError('authority unavailable') from exc
    if not isinstance(claims, dict): raise PermissionError('authority unavailable')
    for field in ('mission','operation','workflow','worker','provider','fence'):
        if type(claims.get(field)) is not type(request[field]) or claims.get(field) != request[field]: raise PermissionError('identity mismatch')
    if claims.get('admitted') is not True or claims.get('lease_current') is not True: raise PermissionError('KCT admission or lease denied')
    expiry = claims.get('lease_expires_at')
    if type(now) not in (int,float) or type(expiry) not in (int,float) or not math.isfinite(now) or not math.isfinite(expiry) or not now < expiry: raise PermissionError('lease expired')
    if type(claims.get('eur_spend')) is not int or claims['eur_spend'] != 0 or claims.get('cost_known') is not True or claims.get('paid_fallback') is not False or claims.get('trial_credit') is not False: raise PermissionError('economic admission denied')
    if claims.get('external_effect') != 'not_started': raise PermissionError('reconcile; never replay unknown or receipted effects')
    return Context(*(request[k] for k in ('mission','operation','worker','provider','fence','workflow')))
