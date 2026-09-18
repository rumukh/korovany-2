# Agent instructions

## Completion means delivered

No work may be claimed finished until both conditions are verified:

1. The changes are committed and integrated into **remote `main`** in
   `rumukh/korovany-2`, not merely present in a local checkout or an open PR.
2. The **GitHub Actions deployment has succeeded** for a remote `main` commit
   containing those changes.

Local implementation, passing local tests, pushing a feature branch, opening a
PR, or merging without a successful deployment are intermediate states, not
completion. This rule applies to code, assets, configuration and documentation.

Use the `Game` workflow in `.github/workflows/game.yml`. Its build, unit-test
and all browser-test jobs must pass before the `deploy` job publishes to GitHub
Pages. Verify the resulting commit SHA and workflow run; a green run for an older
commit, an uploaded artifact, a queued deployment or a skipped deployment does
not satisfy the requirement. Check that the deployed site is reachable and
serves the shipped build.

The live site is <https://rumukh.github.io/korovany-2/>. A completion handoff must
identify the delivered commit and successful Actions run, and link the live
site. While delivery is pending, say so explicitly and continue monitoring.
Report a genuine blocker instead of claiming success.

Preserve unrelated user work and follow repository permissions and branch
protections. Do not bypass required checks, weaken assertions, skip failing
tests or change deployment policy to manufacture a successful result. If
publication needs additional authorization, obtain it and leave the task marked
pending until the delivery requirements are met.

## Validation and browser coverage

Use the existing npm scripts and tests. `npm run build` builds the pinned engine,
type-checks the game and creates the production site. New browser suites must be
assigned exactly once in the workflow's browser matrix; the coverage check is
`tests/ci-selection.test.ts`. Keep keyboard/mouse behavior and saved campaigns
compatible when changing controller input.

Browser and WebGL validation need no GPU permission or resource lease. Use
separate owned profiles and ports, and clean up only processes and files created
for the task. Do not claim physical controller testing from virtual-device tests.
