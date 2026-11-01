# Rollback and recovery

No Factory deployment occurred. Remove **only** the isolated installation (including all logs and user-created files inside it) after manually checking its path:

```
./wolf-ruflo/rollback.sh /absolute/path/to/isolated-install DELETE-ISOLATED-INSTALL
```

The script requires the marker made by the installer and refuses the repository, its ancestors and protected roots. Keep memory stores and backups elsewhere. A temporary installation-directory removal passed; no Factory restoration was performed.

For SQLite context state, stop all writers and retain the original database and any `-journal` file unchanged. `memory.backup(source, new_backup_path)` makes a local SQLite online snapshot, failing if the target exists. `memory.recover_copy(source, new_recovery_path)` copies an **offline** database and any rollback journal, then lets SQLite recover the copy and checks its structure and version. All writers must be stopped before making this copy. Neither method overwrites a pre-existing destination. Failed copies may remain for forensic review. WAL/SHM files are rejected, not recovered. Structural integrity is not proof of semantic correctness or protection against all corruption. Validate content and mission identity independently before any controlled cutover. Keep backups in a separately authorized durable location; none has been provisioned or independently tested here. Production cutover, cross-executor recovery and disaster restoration remain unverified.
