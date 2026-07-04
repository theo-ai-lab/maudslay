/**
 * Recorder — append-only JSONL writer for trajectory evidence. One TrajectoryLine
 * per line so a run can be streamed and replayed without loading it whole. The
 * writer is intentionally dumb: callers (executor, harness) decide what to emit.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  TrajectoryLine,
  TrajectoryHeader,
  TrajectoryStep,
  TrajectoryTerminal,
} from '../src/types.ts';

export class Recorder {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
  }

  write(line: TrajectoryLine): void {
    appendFileSync(this.path, `${JSON.stringify(line)}\n`);
  }

  header(v: TrajectoryHeader): void {
    this.write({ t: 'header', v });
  }

  step(v: TrajectoryStep): void {
    this.write({ t: 'step', v });
  }

  terminal(v: TrajectoryTerminal): void {
    this.write({ t: 'terminal', v });
  }
}
