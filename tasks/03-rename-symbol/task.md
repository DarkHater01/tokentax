# Task: rename-symbol

Rename a function used across two files, updating every call site, so the
hidden tests still pass.

Rules:
- No aliases or shims for the old name.
- Standard library only.
