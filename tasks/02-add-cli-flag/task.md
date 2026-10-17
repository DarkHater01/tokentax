# Task: add-cli-flag

`cli.py` has an `argparse`-based CLI whose `main()` returns the positional
`name`. Add a `--shout` flag.

Behaviour:
- `--shout` is a boolean flag (`action="store_true"`) and defaults to `False`.
- Without it, `main()` returns the name unchanged.
- With it, `main()` returns the name uppercased.

Rules:
- Do not change existing flag behaviour.
- Standard library only.
- Keep `--help` working.

Denominator note: the minimal trajectory is read the spec, read the parser, add
the flag, run the tests.
