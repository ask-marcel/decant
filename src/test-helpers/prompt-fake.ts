import type { Prompt } from '../use-cases/ports/prompt.ts';

export type PromptFake = Prompt & {
  readonly shown: Array<string>;
  readonly asked: Array<string>;
};

// Answers are given in the order the run will ask for them; running out means the operator pressed
// enter on nothing, which the picker refuses.
export const createPromptFake = (answers: ReadonlyArray<string> = []): PromptFake => {
  const remaining = [...answers];
  const shown: string[] = [];
  const asked: string[] = [];
  return {
    shown,
    asked,
    show: (text) => {
      shown.push(text);
    },
    ask: async (question) => {
      asked.push(question);
      return remaining.shift() ?? '';
    },
  };
};
