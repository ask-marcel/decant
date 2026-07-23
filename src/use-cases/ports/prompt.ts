export type Prompt = {
  readonly show: (text: string) => void;
  readonly ask: (question: string) => Promise<string>;
};
