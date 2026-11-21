# sokoban-solver-01-run-20261121: Push-optimal Sokoban solver

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A Sokoban solver that answers every instance of a set at its push-optimal
count. The generator lays a one-cell-wide hallway across the board with
rooms of 3–4 boxes hanging off it through a single door, and a box pushed
out of its room can never come back, so a level's push-optimal count is the
sum of its rooms' optima. `main.ts` therefore splits each level into rooms
(flood fill from each door off the hallway row), solves every room
independently with a push-optimal A* over pushes — canonical player
position, dead-square and 2×2-block pruning, a min-assignment
push-distance heuristic — and stitches the rooms together with plain walks
along the hallway. Scoring is per push, not per move, so each room is
solved at its optimum: on the practice set every instance scores 1,000
points (13, 16, 29, 47 and 60 pushes, the published optima). All search is
budgeted by node expansions, never by the clock, and every iteration order
is fixed, so two runs write identical bytes. The budgets are layered
insurance — a per-stage ladder per room (optimal A* first, then weighted
runs that trade pushes for an answer), a per-instance cap and a global cap
— so a freak draw can never push the run near the set's 60-second wall: a
legal suboptimal solution earns 500 × P* / pushes, an unsolved room earns 0,
and a run past the wall earns nothing at all.

## Run it

```sh
MAKEFUN_INPUT_DIR=<dir with i001..i005/level.txt> MAKEFUN_OUTPUT_DIR=out node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=vm7rhkde&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
