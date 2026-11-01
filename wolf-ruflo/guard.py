"""Pure boundary predicates; not a replacement for KCT or DBOS checks."""
ALLOWED_WORKERS = frozenset(('cezar', 'opencode', 'openhands', 'qwen-code'))

def validate_context(*, worker, authorized, current_lease, spend_eur, cost_known, paid_fallback, trial_credit, external_result):
    if worker not in ALLOWED_WORKERS: raise PermissionError('worker denied')
    if authorized is not True or current_lease is not True: raise PermissionError('KCT/lease required')
    if type(spend_eur) is not int or spend_eur != 0 or cost_known is not True or paid_fallback is not False or trial_credit is not False:
        raise PermissionError('economic policy denied')
    if external_result not in ('not_started', 'recorded'):
        raise PermissionError('unknown external result: reconcile, do not replay')
    return True
