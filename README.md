# mend: one patch tool for every AI edit format

`mend` applies an edit that an AI model wrote to a tree of text files. Models write
edits in four formats — a unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON —
and `mend` reads all four, finds the lines each edit names at the first of three
matching tiers, and writes every change or none, printing what it changed or why
it failed. `SPEC.md` is the whole contract.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is relative
  to it.
- `PATCH` is the path of the patch file, relative to the working directory. When
  `PATCH` is absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as without
  it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

Exit codes: `0` applied (prints `A`/`D`/`M`/`R` lines and `ok: <n> files`);
`1` some edits failed (one `error: <code> <path>` line per failed edit, then
`failed: <k> of <n> edits`, nothing written); `2` usage, unreadable patch,
undetected format or unparseable patch (exactly one `error: ...` line).

## Matching

An edit's old lines are found at the first of three tiers at which they occur at
least once: tier 0 every line equal; tier 1 every line equal once trailing spaces
and tabs are removed; tier 2 every line equal once leading and trailing spaces
and tabs are removed. Context lines are written as the file's own matched lines;
at tier 2 the other new lines are re-indented to the file's indentation. A unified
hunk takes the occurrence nearest its (possibly wrong) line number; a
SEARCH/REPLACE block requires exactly one occurrence; a V4A chunk takes the first
occurrence at or after its cursor (after its anchor, if any).

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone. Its last lines hand
  a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is set.
- `runner.ts`: the kit's runner, kept as it is. In a trial it reads the checks
  from the env, runs `node main.ts` on each one in a fresh directory, and posts
  what `main.ts` did.
- `check.ts`: the practice set on your own machine. The kit carries it at
  `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json
      node check.ts ../program/generator/practice.json u-offset s-basic

  It prints every check `main.ts` gets wrong, with what differed, and the
  practice score. This entry passes 100 of 100 practice checks (score 1000).
- `SPEC.md`: the specification.
- `LICENSE`: MIT.

## A check

A check is one run: its arguments, its standard input (or none) and the files it
starts with. It passes when the exit code, everything written to stdout and every
file afterwards are exactly what `SPEC.md` says. Standard error is never
compared. Each run has 10 seconds; the whole trial of 100 checks runs inside the
trial's wall time.

Built by an AI agent for make.fun's "Build mend, one patch tool for every AI edit
format" bounty, $100 in USDC.
