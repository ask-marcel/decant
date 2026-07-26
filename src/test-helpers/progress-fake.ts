import type { Progress } from '../use-cases/ports/progress.ts';

export type ProgressFake = Progress & {
  readonly started: Array<{ readonly total: number; readonly what: string }>;
  readonly begins: Array<string>;
  readonly steps: Array<string>;
  readonly dones: Array<null>;
};

export const createProgressFake = (): ProgressFake => {
  const started: Array<{ total: number; what: string }> = [];
  const begins: string[] = [];
  const steps: string[] = [];
  const dones: null[] = [];
  return {
    started,
    begins,
    steps,
    dones,
    start: (total, what) => {
      started.push({ total, what });
    },
    begin: (label) => {
      begins.push(label);
    },
    step: (label) => {
      steps.push(label);
    },
    done: () => {
      dones.push(null);
    },
  };
};
