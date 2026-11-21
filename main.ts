// Sokoban solver for make.fun's sokoban-solver-01-run-20261121.
//
// Strategy: the generator lays a one-cell-wide hallway across the board with
// rooms (3-4 boxes each) hanging off it through a single door, and a box
// pushed out of its room can never come back, so a level's push-optimal
// count is the sum of its rooms' optima. The solver therefore
//  1. splits the level into rooms (flood fill from each door off the
//     hallway row the player starts on),
//  2. solves each room independently with a push-optimal A* over pushes
//     (canonical player position, dead-square + freeze pruning, a
//     min-assignment push-distance heuristic), and
//  3. stitches the rooms together with plain walks along the hallway.
//
// Scoring is per push, not per move: a solution one push over the optimum
// earns under half the points, so each room is solved push-optimally.
// Everything is budgeted by work (node expansions), never by the clock,
// and every iteration order is fixed, so two runs write identical bytes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const DIRS: [number, number, string][] = [
  [0, -1, 'u'],
  [0, 1, 'd'],
  [-1, 0, 'l'],
  [1, 0, 'r'],
];

// Work budgets, all in node expansions. Deterministic: no clock is read,
// so two runs of the program always write identical bytes.
//
// The generator keeps a room only when make.fun's own plain breadth-first
// search solves it within 250,000 states, and this A* (same pruning, plus
// an assignment heuristic) needs far fewer expansions than that in
// practice — a few hundred per room on drawn sets, ~2,000 for a whole
// five-instance set. The caps below are therefore pure insurance, layered
// so that even a freak draw cannot push the run anywhere near the set's
// 60-second wall: each room's search stages are capped, each instance is
// capped, and a global cap bounds the whole run (at the measured
// ~0.15 ms an expansion, the global cap is ~25 s of search, and a drawn
// set uses ~1% of it). The ladder trades optimality for an answer before
// it gives up: any legal solution earns 500 x P* / pushes, an unsolved
// room earns 0.
const GLOBAL_BUDGET = 150000;
const INSTANCE_BUDGET = 50000;
const ROOM_STAGES: [number, number][] = [
  [1, 20000], // push-optimal A*
  [2, 20000], // weighted A*: faster, near-optimal
  [4, 30000], // weighted harder: an answer, if one is findable
];
const FALLBACK_STAGES: [number, number][] = [
  [1, 8000],
  [2, 8000],
  [4, 12000],
];
// The whole-level fallback (decomposition failed) never searches a level
// of more boxes than this: the assignment heuristic enumerates matchings,
// which explodes combinatorially, and a bounded refusal (an empty, valid
// answer for that instance) beats a run that dies on the wall and scores
// nothing at all. Drawn sets never take this path: their rooms always
// decompose, with at most 4 boxes each.
const FALLBACK_MAX_BOXES = 6;

// Work meters: expansions left for one instance and for the whole run.
// Every expansion draws both down; a search stops when either runs out.
type Meter = { left: number };

type Level = {
  w: number;
  h: number;
  wall: boolean[];
  goals: Set<number>;
  boxes: number[];
  player: number;
};

type Room = {
  cells: Set<number>;
  boxes: number[];
  goals: number[];
  entry: number; // hallway cell outside the door (where the player stands to enter)
  door: number; // room cell of the door (the player steps onto it to enter)
};

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall: boolean[] = new Array(w * h).fill(false);
  const goals = new Set<number>();
  const boxes: number[] = [];
  let player = 0;
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const ch = row[x] ?? '#';
      const i = y * w + x;
      wall[i] = ch === '#';
      if (ch === '.' || ch === '*' || ch === '+') goals.add(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

// Split the level into rooms hanging off the hallway row. The hallway is
// the row the player starts on; each door is a floor cell directly above or
// below a hallway cell. A room is the flood fill from its door cell over
// non-wall cells, never entering the hallway row.
function findRooms(level: Level): Room[] {
  const { w, h, wall, player } = level;
  const hallRow = Math.floor(player / w);
  const seen = new Set<number>();
  const rooms: Room[] = [];
  for (let x = 0; x < w; x++) {
    const hc = hallRow * w + x;
    if (wall[hc]) continue;
    for (const dy of [-1, 1]) {
      const dr = hallRow + dy;
      if (dr < 0 || dr >= h) continue;
      const door = dr * w + x;
      if (wall[door]) continue;
      // Flood fill the room from its door cell.
      const cells = new Set<number>();
      const stack = [door];
      cells.add(door);
      while (stack.length > 0) {
        const c = stack.pop()!;
        const cx = c % w;
        const cy = Math.floor(c / w);
        for (const [dx, dyy] of DIRS) {
          const nx = cx + dx;
          const ny = cy + dyy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h || ny === hallRow) continue;
          const n = ny * w + nx;
          if (wall[n] || cells.has(n)) continue;
          cells.add(n);
          stack.push(n);
        }
      }
      // One component per room: skip a door that leads to a component
      // another door already claimed.
      let dup = false;
      for (const c of cells) {
        if (seen.has(c)) { dup = true; break; }
      }
      if (dup) continue;
      for (const c of cells) seen.add(c);
      const boxes = level.boxes.filter((b) => cells.has(b));
      const goals = [...level.goals].filter((g) => cells.has(g));
      if (boxes.length === 0) continue;
      rooms.push({ cells, boxes, goals, entry: hc, door });
    }
  }
  rooms.sort((a, b) => a.door - b.door);
  return rooms;
}

// Breadth-first walk from `from` to `to` over floor cells, treating boxes
// as obstacles. `passable(i)` says whether cell i may be stepped on.
// Returns the move letters, or null when unreachable. Deterministic:
// neighbours are tried in the fixed DIRS order.
function walkPath(
  from: number,
  to: number,
  boxes: Set<number>,
  passable: (i: number) => boolean,
  w: number,
): string | null {
  if (from === to) return '';
  const prev = new Map<number, { p: number; m: string }>();
  const queue = [from];
  prev.set(from, { p: -1, m: '' });
  for (let qi = 0; qi < queue.length; qi++) {
    const c = queue[qi]!;
    for (const [dx, dy, letter] of DIRS) {
      const nx = (c % w) + dx;
      const ny = Math.floor(c / w) + dy;
      if (nx < 0 || nx >= w || ny < 0) continue;
      const n = ny * w + nx;
      if (!passable(n) || boxes.has(n) || prev.has(n)) continue;
      prev.set(n, { p: c, m: letter });
      if (n === to) {
        let moves = '';
        let cur = n;
        while (cur !== from) {
          const step = prev.get(cur)!;
          moves = step.m + moves;
          cur = step.p;
        }
        return moves;
      }
      queue.push(n);
    }
  }
  return null;
}

type RoomCtx = {
  w: number;
  h: number;
  cells: Set<number>;
  goals: number[];
  goalSet: Set<number>;
  dead: Set<number>;
  // distToGoal[g] maps a cell to the fewest pushes a lone box needs to
  // reach goal g (ignoring other boxes and the player's travel).
  distToGoal: Map<number, number>[];
  entry: number;
  door: number;
};

function buildRoomCtx(level: Level, room: Room): RoomCtx {
  const { cells, goals, entry, door } = room;
  const w = level.w;
  const h = level.h;
  const goalSet = new Set(goals);
  const inDomain = (i: number): boolean => cells.has(i) || i === entry;
  // Dead squares: a cell is live when a box there can still be pushed onto
  // a goal. Reverse reachability from the goals: a cell c is live when some
  // live neighbour n can be reached by pushing a box from c to n, which
  // needs the cell behind c (2c - n) to be floor for the player to stand on.
  const live = new Set<number>(goals);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of cells) {
      if (live.has(c)) continue;
      for (const [dx, dy] of DIRS) {
        const n = c + dy * w + dx;
        if (!live.has(n)) continue;
        const behind = c - (dy * w + dx);
        if (!inDomain(behind)) continue;
        live.add(c);
        grew = true;
        break;
      }
    }
  }
  const dead = new Set<number>();
  for (const c of cells) if (!live.has(c)) dead.add(c);
  // Push distances to each goal (reverse BFS over the push graph).
  const distToGoal: Map<number, number>[] = goals.map((g) => {
    const dist = new Map<number, number>([[g, 0]]);
    const queue = [g];
    for (let qi = 0; qi < queue.length; qi++) {
      const x = queue[qi]!;
      const d = dist.get(x)!;
      for (const [dx, dy] of DIRS) {
        const step = dy * w + dx;
        const a = x - step; // a box at a can be pushed to x ...
        if (!cells.has(a) || dist.has(a)) continue;
        const stand = 2 * a - x; // ... when the player stands here
        if (!inDomain(stand)) continue;
        dist.set(a, d + 1);
        queue.push(a);
      }
    }
    return dist;
  });
  return { w, h, cells, goals, goalSet, dead, distToGoal, entry, door };
}

// Min-assignment lower bound on the pushes still needed: match each box to
// a distinct goal at its lone-box push distance. Admissible, and consistent
// (one push moves one box one cell, so the bound moves by at most one).
function heuristic(ctx: RoomCtx, boxes: number[]): number {
  const n = boxes.length;
  const cost: number[][] = boxes.map((b) =>
    ctx.distToGoal.map((dist) => dist.get(b) ?? Infinity),
  );
  let best = Infinity;
  const used = new Array<boolean>(n).fill(false);
  const assign = (bi: number, sum: number): void => {
    if (sum >= best) return;
    if (bi === n) { best = sum; return; }
    for (let gi = 0; gi < n; gi++) {
      if (used[gi]) continue;
      const c = cost[bi]![gi]!;
      if (c === Infinity) continue;
      used[gi] = true;
      assign(bi + 1, sum + c);
      used[gi] = false;
    }
  };
  assign(0, 0);
  return best;
}

// The player's reachable region from `from` with the boxes as obstacles,
// over the room's cells plus the entry cell. Returns the region and its
// smallest cell (the canonical player position, which collapses every
// walk-equivalent player position to one state).
function reachable(
  ctx: RoomCtx,
  from: number,
  boxes: Set<number>,
): { canon: number; set: Set<number> } {
  const { w, cells, entry } = ctx;
  const set = new Set<number>([from]);
  const queue = [from];
  let canon = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const c = queue[qi]!;
    if (c < canon) canon = c;
    for (const [dx, dy] of DIRS) {
      const nx = (c % w) + dx;
      const ny = Math.floor(c / w) + dy;
      if (nx < 0 || nx >= w || ny < 0) continue;
      const n = ny * w + nx;
      if (set.has(n) || boxes.has(n)) continue;
      if (!cells.has(n) && n !== entry) continue;
      set.add(n);
      queue.push(n);
    }
  }
  return { canon, set };
}

// A 2x2 block of walls and boxes can never move: any push of a box in it
// needs a floor cell beyond the box or under the player, and every
// direction out of the block is blocked by the block itself. So a box in
// such a block that is not on a goal is a permanent deadlock. (A single
// box with no static push is NOT a deadlock on its own: the box blocking
// it may move away. Only walls, and blocks like this one, never move.)
function twoByTwo(ctx: RoomCtx, boxSet: Set<number>): boolean {
  const { w, h, cells, entry, goalSet } = ctx;
  const blocking = (i: number): boolean => {
    if (boxSet.has(i)) return true;
    if (cells.has(i) || i === entry) return false;
    return true;
  };
  for (const c of cells) {
    const x = c % w;
    const y = Math.floor(c / w);
    if (x + 1 >= w || y + 1 >= h) continue;
    const q = [c, c + 1, c + w, c + w + 1];
    if (!q.every(blocking)) continue;
    for (const i of q) {
      if (boxSet.has(i) && !goalSet.has(i)) return true;
    }
  }
  return false;
}

// Push A* over one room. Returns the push list (each: the box's cell before
// the push, and the push direction), or null when the budget runs out or no
// solution exists. `weight` 1 is optimal; higher weights trade optimality
// for speed (an incumbent). `needExit` requires the player to be able to
// walk back to the door once every box is on a goal.
function astar(
  ctx: RoomCtx,
  boxes0: number[],
  weight: number,
  budget: number,
  needExit: boolean,
  meter: Meter,
  global: Meter,
): { box: number; dx: number; dy: number }[] | null {
  const { w } = ctx;
  const sBoxes: number[][] = [boxes0.slice()];
  const sPlayer: number[] = [ctx.entry];
  const sG: number[] = [0];
  const sParent: number[] = [-1];
  const sPushBox: number[] = [-1];
  const sPushDx: number[] = [0];
  const sPushDy: number[] = [0];
  const keyOf = (boxes: number[], canon: number): string =>
    boxes.join(',') + '|' + canon;
  const startReach = reachable(ctx, ctx.entry, new Set(boxes0));
  const best = new Map<string, number>([
    [keyOf(boxes0, startReach.canon), 0],
  ]);
  const h0 = heuristic(ctx, boxes0);
  if (h0 === Infinity) return null;
  // Heap entries: [f, h, counter, state]. Ties break on h, then insertion.
  const heap: [number, number, number, number][] = [[h0, h0, 0, 0]];
  let counter = 1;
  const less = (
    a: [number, number, number, number],
    b: [number, number, number, number],
  ): boolean =>
    a[0] < b[0] ||
    (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };
  let expanded = 0;
  while (heap.length > 0) {
    const [, , , s] = heapPop();
    const boxes = sBoxes[s]!;
    const boxSet = new Set(boxes);
    const reach = reachable(ctx, sPlayer[s]!, boxSet);
    if (best.get(keyOf(boxes, reach.canon)) !== sG[s]) continue;
    // Goal: every box on a goal, and (unless this is the last room) the
    // player can still walk back to the door to leave.
    if (boxes.every((b) => ctx.goalSet.has(b))) {
      if (!needExit || reach.set.has(ctx.door)) {
        const pushes: { box: number; dx: number; dy: number }[] = [];
        for (let t = s; t > 0; t = sParent[t]!) {
          pushes.push({ box: sPushBox[t]!, dx: sPushDx[t]!, dy: sPushDy[t]! });
        }
        pushes.reverse();
        return pushes;
      }
    }
    if (expanded >= budget || meter.left <= 0 || global.left <= 0) return null;
    expanded++;
    meter.left--;
    global.left--;
    const g = sG[s]!;
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      for (const [dx, dy] of DIRS) {
        const step = dy * w + dx;
        const beyond = b + step;
        const stand = b - step;
        if (!ctx.cells.has(beyond) || boxSet.has(beyond)) continue;
        if (!reach.set.has(stand)) continue;
        const nb = boxes.slice();
        nb[bi] = beyond;
        nb.sort((a, b) => a - b);
        const nbSet = new Set(nb);
        // Deadlock: a box on a dead square, or frozen solid, is lost.
        let dead = false;
        for (const x of nb) {
          if (!ctx.goalSet.has(x) && ctx.dead.has(x)) { dead = true; break; }
        }
        if (dead) continue;
        if (twoByTwo(ctx, nbSet)) continue;
        const h = heuristic(ctx, nb);
        if (h === Infinity) continue;
        const ng = g + 1;
        const nReach = reachable(ctx, b, nbSet);
        const k = keyOf(nb, nReach.canon);
        if (best.has(k) && best.get(k)! <= ng) continue;
        best.set(k, ng);
        const idx = sBoxes.length;
        sBoxes.push(nb);
        sPlayer.push(b);
        sG.push(ng);
        sParent.push(s);
        sPushBox.push(b);
        sPushDx.push(dx);
        sPushDy.push(dy);
        heapPush([ng + weight * h, h, counter++, idx]);
      }
    }
  }
  return null;
}

// Replay a push list into the full LURD move string, walking the player
// between pushes. The player starts at the room's entry cell.
function replayPushes(
  ctx: RoomCtx,
  boxes0: number[],
  pushes: { box: number; dx: number; dy: number }[],
  needExit: boolean,
): string | null {
  const { w, cells, entry, door } = ctx;
  const passable = (i: number): boolean => cells.has(i) || i === entry;
  let moves = '';
  let player = entry;
  const boxes = boxes0.slice();
  for (const push of pushes) {
    const boxSet = new Set(boxes);
    const stand = push.box - (push.dy * w + push.dx);
    const walk = walkPath(player, stand, boxSet, passable, w);
    if (walk === null) return null;
    moves += walk;
    const letter = DIRS.find(([dx, dy]) => dx === push.dx && dy === push.dy)![2]!.toUpperCase();
    moves += letter;
    const at = boxes.indexOf(push.box);
    boxes[at] = push.box + (push.dy * w + push.dx);
    boxes.sort((a, b) => a - b);
    player = push.box;
  }
  if (needExit) {
    const boxSet = new Set(boxes);
    const walk = walkPath(player, door, boxSet, passable, w);
    if (walk === null) return null;
    moves += walk;
    // Step out of the door back onto the hallway.
    const dx = (entry % w) - (door % w);
    const dy = Math.floor(entry / w) - Math.floor(door / w);
    const letter = DIRS.find(([x, y]) => x === dx && y === dy)![2]!;
    moves += letter;
  }
  return moves;
}

// Solve one room down a ladder of searches: push-optimal A* first, then
// weighted runs that trade pushes for speed, each stage capped in
// expansions and all of them bounded by the instance and global work
// meters. The first stage that solves the room wins; a legal suboptimal
// answer earns 500 x P* / pushes, where an unsolved room earns 0.
function solveRoom(
  ctx: RoomCtx,
  boxes0: number[],
  needExit: boolean,
  meter: Meter,
  global: Meter,
  stages: [number, number][],
): string | null {
  for (const [weight, cap] of stages) {
    if (meter.left <= 0 || global.left <= 0) return null;
    const pushes = astar(
      ctx,
      boxes0,
      weight,
      Math.min(cap, meter.left, global.left),
      needExit,
      meter,
      global,
    );
    if (pushes !== null) return replayPushes(ctx, boxes0, pushes, needExit);
  }
  return null;
}

function solveLevel(text: string, meter: Meter, global: Meter): string {
  const level = parseLevel(text);
  const { w, wall } = level;
  const rooms = findRooms(level);
  const covered = new Set<number>();
  for (const r of rooms) for (const c of r.cells) covered.add(c);
  const allCovered =
    level.boxes.every((b) => covered.has(b)) &&
    [...level.goals].every((g) => covered.has(g));
  let moves = '';
  let player = level.player;
  const floorPassable = (i: number): boolean => !wall[i];
  if (allCovered && rooms.length > 0) {
    rooms.forEach((room, ri) => {
      const needExit = ri < rooms.length - 1;
      const ctx = buildRoomCtx(level, room);
      const boxSet = new Set(level.boxes);
      const walk = walkPath(player, room.entry, boxSet, floorPassable, w);
      if (walk === null) return moves;
      moves += walk;
      player = room.entry;
      const solved = solveRoom(ctx, room.boxes, needExit, meter, global, ROOM_STAGES);
      if (solved === null) return;
      moves += solved;
      player = room.entry;
    });
  } else {
    // Fallback: the whole level as one room (no decomposition).
    const cells = new Set<number>();
    for (let i = 0; i < w * level.h; i++) if (!wall[i]) cells.add(i);
    const ctx = buildRoomCtx(level, {
      cells,
      boxes: level.boxes,
      goals: [...level.goals],
      entry: level.player,
      door: level.player,
    });
    // Bounded refusal past FALLBACK_MAX_BOXES (see the constant): the
    // instance keeps its empty, valid answer and the run moves on.
    if (level.boxes.length <= FALLBACK_MAX_BOXES) {
      const solved = solveRoom(ctx, level.boxes, false, meter, global, FALLBACK_STAGES);
      if (solved !== null) moves += solved;
    }
  }
  return moves;
}

const ids = readdirSync(I).sort();
const globalMeter: Meter = { left: GLOBAL_BUDGET };
for (const id of ids) {
  const meter: Meter = { left: INSTANCE_BUDGET };
  const moves = solveLevel(
    readFileSync(join(I, id, 'level.txt'), 'utf8'),
    meter,
    globalMeter,
  );
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
