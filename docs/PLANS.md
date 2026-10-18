# Plans and work tracking

Beads is the durable plan, dependency graph and handoff record. Run `bd prime` and `bd ready`
at session start; claim a bead before editing. Write concrete acceptance criteria and link new
work with `discovered-from`. Append evidence, close completed work with a reason, and inspect
the newly ready work. Do not mirror statuses in markdown checklists.

The initial local checkout uses prefix `jlib`. It is a new tracker, not a copy of another
project's database. When joining a published checkout, use `bd bootstrap` to recover the
remote tracker. Configure the clone-local role with `git config beads.role contributor`
(or `maintainer` for repository administrators). Do not reinitialize existing history. Before the remote is created, changes
remain local. Once authorized, use `bd dolt push` and `bd dolt pull` for tracker sync.

Design documents explain mechanisms; decisions record settled choices; Beads records pending
work and blockers. [The quality record](QUALITY_SCORE.md) links verification commands so another
agent can reproduce evidence without chat history.
