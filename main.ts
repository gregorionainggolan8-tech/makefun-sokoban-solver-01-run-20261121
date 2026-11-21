// A push-optimal Sokoban solver for make.fun's "Build the best Sokoban solver" bounty.
//
// Approach
// --------
// Every generated level is a one-square-wide hallway with 1-4 small rooms off it
// (3-4 boxes and as many goals each). A box pushed out of a room through its door
// can never be pushed back, so each room is an independent problem and the
// level's push-optimal count is the sum of its rooms' optima. This program
// therefore:
//
//   1. splits a level into rooms by cutting the hallway row's dead squares
//      (squares from which a box can never reach a goal) out of the floor;
//   2. solves each room on its own with a breadth-first search over *pushes*
//      (the first solved state a BFS meets is push-optimal), pruning with
//      dead-square analysis and frozen 2x2-block detection;
//   3. stitches the rooms' push sequences together with shortest player walks.
//
// A state is the boxes' squares plus the player's reachable region (named by
// its lowest square), so all player positions inside one region collapse to a
// single state. The search budget is counted in states, never in wall-clock
// time, so two executions on the same set always write the same bytes.
//
// Fallbacks (in order): room-by-room search, whole-level search, both again
// with a larger state budget, and finally an empty (valid, unscored) answer,
// so every instance is always answered in the stated format.
//
// Node 22, plain TypeScript with erasable syntax only. No network, no clock,
// no randomness, no files outside /input, /output and /bot.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The four moves: [dx, dy, walk letter, push letter]. */
const DIRS: ReadonlyArray<readonly [number, number, string, string]> = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

/** States one room search may keep before it gives up (the generator's rooms
 *  are kept only when this same search solves them within this many). */
const ROOM_STATE_CAP = 250_000;
/** Larger cap for the retry passes. */
const RETRY_STATE_CAP = 2_000_000;
/** Total states the whole run may spend, so a pathological instance can never
 *  eat the 60-second wall for the set. */
const RUN_STATE_BUDGET = 6_000_000;

type Level = {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
};

type Solved = { pushes: number; moves: string };

/** How many states the run has spent so far (work budget, never the clock). */
let statesSpent = 0;

/** Parse XSB text (# wall, space floor, . goal, $ box, * box on goal, @ player). */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x] ?? '#';
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outer frame is wall whatever it shows.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * Live squares: the squares from which a box, pushed on its own, can reach
 * some goal. Found by pulling a box back from the goals: a box on square y
 * can be pushed onto a live square x = y + d when the player can stand on
 * y - d. A box that starts off a live square can never be solved.
 */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = goals.slice();
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (y < 0 || y >= wall.length) continue;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * Flood-fill the player's reachable region from `from` around walls and the
 * squares marked in `occupied`, stamping it in `seen`; returns the region's
 * lowest square, which names the region in a state's key.
 */
function reach(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    // Four neighbours, written out to keep the hot loop tight.
    const up = p - w;
    const down = p + w;
    const left = p - 1;
    const right = p + 1;
    if (wall[up] === 0 && occupied[up] === 0 && seen[up] !== stamp) {
      seen[up] = stamp;
      stack[n++] = up;
    }
    if (wall[down] === 0 && occupied[down] === 0 && seen[down] !== stamp) {
      seen[down] = stamp;
      stack[n++] = down;
    }
    if (wall[left] === 0 && occupied[left] === 0 && seen[left] !== stamp) {
      seen[left] = stamp;
      stack[n++] = left;
    }
    if (wall[right] === 0 && occupied[right] === 0 && seen[right] !== stamp) {
      seen[right] = stamp;
      stack[n++] = right;
    }
  }
  return low;
}

/**
 * Whether the box just pushed onto `t` sits in a frozen 2x2 block: four
 * squares of walls and boxes holding a box off its goal. No box in such a
 * block can ever move again, so the state is dead.
 */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (a < 0 || d >= wall.length) continue;
    if (!(wall[a] || occupied[a])) continue;
    if (!(wall[b] || occupied[b])) continue;
    if (!(wall[c] || occupied[c])) continue;
    if (!(wall[d] || occupied[d])) continue;
    if (
      (occupied[a] && !goal[a]) ||
      (occupied[b] && !goal[b]) ||
      (occupied[c] && !goal[c]) ||
      (occupied[d] && !goal[d])
    ) {
      return true;
    }
  }
  return false;
}

/** Shortest walk from `from` to `to` around walls and boxes, in lower-case LURD. */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue: number[] = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: push square out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/**
 * The push-optimal solution of `level` (or null when the search gives up):
 * a breadth-first search over pushes. States are visited in order of pushes
 * made, so the first solved state met is optimal. Boxes are packed into one
 * number per state (base `size` digits, lowest square of the player's region
 * prepended) for a compact, exact state key.
 */
function solvePushes(level: Level, maxStates: number): Solved | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const n = level.boxes.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  for (const b of level.boxes) if (!live[b]) return null;

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  // Powers of the board size: key = regionLow * size^n + packed boxes.
  let pow = 1;
  for (let i = 0; i < n; i++) pow *= size;

  const pack = (boxes: Int32Array, count: number): number => {
    let k = 0;
    for (let i = 0; i < count; i++) k = k * size + boxes[i]!;
    return k;
  };
  const unpack = (packed: number, out: Int32Array, count: number): void => {
    let p = packed;
    for (let i = count - 1; i >= 0; i--) {
      out[i] = p % size;
      p = Math.floor(p / size);
    }
  };
  const isSolved = (boxes: Int32Array, count: number): boolean => {
    for (let i = 0; i < count; i++) if (!goal[boxes[i]!]) return false;
    return true;
  };

  const cap = Math.min(maxStates, Math.max(0, RUN_STATE_BUDGET - statesSpent));
  if (cap <= 0) return null;

  // Per-state storage: packed boxes, the player square after the push that
  // made the state, the parent state, and the push (box square before, dir).
  const stBoxes: number[] = [];
  const stPlayer: number[] = [];
  const stParent: number[] = [];
  const stFrom: number[] = [];
  const stDir: number[] = [];

  const startBoxes = new Int32Array(n);
  for (let i = 0; i < n; i++) startBoxes[i] = level.boxes[i]!;
  for (const b of level.boxes) occupied[b] = 1;
  const startLow = reach(level, occupied, level.player, seen, ++stamp, stack);
  for (const b of level.boxes) occupied[b] = 0;

  const index = new Map<number, number>();
  stBoxes.push(pack(startBoxes, n));
  stPlayer.push(level.player);
  stParent.push(-1);
  stFrom.push(-1);
  stDir.push(-1);
  index.set(startLow * pow + stBoxes[0]!, 0);
  statesSpent++;

  let found = isSolved(startBoxes, n) ? 0 : -1;
  const cur = new Int32Array(n);
  const next = new Int32Array(n);

  for (let head = 0; found < 0 && head < stBoxes.length; head++) {
    unpack(stBoxes[head]!, cur, n);
    for (const b of cur) occupied[b] = 1;
    reach(level, occupied, stPlayer[head]!, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < n && found < 0; bi++) {
      const b = cur[bi]!;
      for (let k = 0; k < 4; k++) {
        const [dx, dy] = DIRS[k]!;
        const d = dy * w + dx;
        const t = b + d;
        if (t < 0 || t >= size) continue;
        // The player must reach the square behind the box, and the box must
        // land on open, live floor.
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let key = -1;
        let packedNext = -1;
        if (!frozen) {
          for (let i = 0; i < n; i++) next[i] = cur[i]!;
          next[bi] = t;
          // Insertion-sort the few boxes back into order.
          for (let i = 1; i < n; i++) {
            const v = next[i]!;
            let j = i - 1;
            while (j >= 0 && next[j]! > v) {
              next[j + 1] = next[j]!;
              j--;
            }
            next[j + 1] = v;
          }
          packedNext = pack(next, n);
          const low = reach(level, occupied, b, mark, ++stamp, stack);
          key = low * pow + packedNext;
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || index.has(key)) continue;
        if (stBoxes.length >= cap) {
          for (const x of cur) occupied[x] = 0;
          return null;
        }
        index.set(key, stBoxes.length);
        stBoxes.push(packedNext);
        stPlayer.push(b);
        stParent.push(head);
        stFrom.push(b);
        stDir.push(k);
        statesSpent++;
        if (isSolved(next, n)) {
          found = stBoxes.length - 1;
          break;
        }
      }
    }
    for (const x of cur) occupied[x] = 0;
  }
  if (found < 0) return null;

  // Rebuild the moves: walk to each push, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = stParent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  const before = new Int32Array(n);
  for (const s of path) {
    const p = stParent[s]!;
    unpack(stBoxes[p]!, before, n);
    for (const b of before) occupied[b] = 1;
    const k = stDir[s]!;
    const [dx, dy, , pushLetter] = DIRS[k]!;
    const d = dy * w + dx;
    moves += walkTo(level, occupied, player, stFrom[s]! - d);
    for (const b of before) occupied[b] = 0;
    moves += pushLetter;
    player = stFrom[s]!;
  }
  return { pushes: path.length, moves };
}

/** The square the player stands on after playing `moves` from `from`. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves) {
    const c = ch.toLowerCase();
    p += c === 'u' ? -w : c === 'd' ? w : c === 'l' ? -1 : 1;
  }
  return p;
}

type Room = {
  boxes: number[];
  goals: number[];
  done: boolean;
};

/**
 * The level's rooms: cut the hallway row's dead squares (a box there reaches
 * no goal) out of the floor; each remaining part holding a box is a room.
 * Null when the level is no set of rooms (a box in the hallway, a goal cut
 * off, or a room's boxes and goals not matching).
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const q0 = squares[i]!;
      for (const [dx, dy] of DIRS) {
        const q = q0 + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) {
    if (part[g]! < 0) return null;
    rooms[part[g]!]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * Solve the level room by room: each room's push-optimal solution in turn,
 * the other rooms' boxes standing as walls (on their goals once their room
 * is done), the player walking on from where the last room left it.
 */
function solveByRooms(level: Level, maxStates: number): Solved | null {
  const rooms = roomsOf(level);
  if (rooms === null) return null;
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solvePushes(sub, maxStates);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

/** Solve one level, with fallbacks so an answer is always produced. */
function solveLevel(text: string): string {
  let level: Level;
  try {
    level = parseLevel(text);
  } catch {
    return '';
  }
  try {
    const byRooms = solveByRooms(level, ROOM_STATE_CAP);
    if (byRooms !== null) return byRooms.moves;
    const whole = solvePushes(level, ROOM_STATE_CAP);
    if (whole !== null) return whole.moves;
    const byRoomsRetry = solveByRooms(level, RETRY_STATE_CAP);
    if (byRoomsRetry !== null) return byRoomsRetry.moves;
    const wholeRetry = solvePushes(level, RETRY_STATE_CAP);
    if (wholeRetry !== null) return wholeRetry.moves;
  } catch {
    // Any failure falls through to the empty answer below.
  }
  return '';
}

for (const id of readdirSync(I).sort()) {
  let moves = '';
  try {
    moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
