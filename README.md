# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/skwanz001/mend/rank.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/skwanz001/mend/reward.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files, entered in
make.fun's "Build mend, one patch tool for every AI edit format" bounty.
`main.ts` is the whole tool: Node 22 and its standard library alone, run as
`node main.ts [options] [PATCH]`. `SPEC.md` is the whole specification.

It reads a patch in one of four formats — a unified diff (often with wrong line
numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls
as JSON — finds the lines each edit names at the first of three matching tiers
(exact, trailing whitespace, then leading and trailing whitespace, with
re-indentation at the third), and writes every change or none: a failed edit
changes nothing, the edits after it still run, and every failure is reported.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is the patch file, or `-` (or nothing) to read it from standard input.
`--format=NAME` forces one format (`unified`, `search-replace`, `v4a`, `json`;
`auto` detects it). `--check` does everything but write. `--strict` matches
lines exactly, tier 0 only.

## Practice

```sh
node check.ts ../program/generator/practice.json
```

100 of 100 practice checks pass: practice score 1000 (unified 30,
search_replace 20, v4a 20, json 15, cli 15). Twenty extra edge cases of my
own — creates without a trailing newline, renames, CRLF files, `--strict`,
`--check`, atomic failure, ambiguous blocks, pure V4A renames — all pass too.

## The files

- `main.ts`: the CLI. Sections 1–10 of SPEC.md: the command line, output and
  exit codes, safe paths, format detection, line matching at three tiers,
  unified diffs, SEARCH/REPLACE blocks, V4A patches, JSON edits, and the
  all-or-nothing write. Its last lines hand a trial over to `runner.ts` when
  `MAKEFUN_ENV_URL` is set.
- `runner.ts`: keep it as it is. In a trial it reads the checks from the env,
  runs `node main.ts` on each one in a fresh directory, and posts what it did.
- `check.ts`: the practice set on your own machine.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.
