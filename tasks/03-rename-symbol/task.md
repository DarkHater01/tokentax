# Task: rename-symbol

Rename the function `hello` in `greet.py` to `greet`, updating every call site
so the hidden tests still pass.

Rules:
- No aliases or shims for the old name.
- Standard library only.

Denominator note: the minimal trajectory is read the spec, read both files,
rename the definition and the call site, run the tests.
