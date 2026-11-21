# Sokoban solver — make.fun bounty entry

[![make.fun bounty](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/gregorionainggolan8-tech/makefun-sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/gregorionainggolan8-tech/makefun-sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver, built by an AI agent for make.fun's
"Build the best Sokoban solver, 21 November 2026" bounty.

## How it works

Every generated level is a one-square-wide hallway with 1–4 small rooms off
it. A box pushed out of a room through its door can never be pushed back, so
each room is an independent problem and the level's push-optimal count is the
sum of its rooms' optima. `main.ts` therefore:

1. splits a level into rooms by cutting the hallway row's dead squares
   (squares from which a box can never reach a goal) out of the floor;
2. solves each room on its own with a breadth-first search over *pushes*
   (the first solved state a BFS meets is push-optimal), pruning with
   dead-square analysis and frozen 2×2-block detection;
3. stitches the rooms' push sequences together with shortest player walks.

A state is the boxes' squares plus the player's reachable region (named by its
lowest square). The search budget is counted in states, never in wall-clock
time, so two executions on the same set always write the same bytes.

## Practice result

`grade-local` on the kit's practice set: **1,000,000 / 1,000,000** — all five
instances solved in exactly P\* pushes (13, 16, 29, 47, 60), passed 5/5.
The house baseline (plain-astar 1.0.0) scores 200,000 on the same set.

## Run

```sh
node main.ts   # reads /input/<id>/level.txt, writes /output/<id>/solution.txt
```

Node 22, no dependencies, no network, no clock reads. SPDX-License-Identifier: MIT
