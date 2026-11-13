// Works through a queue with a fixed number of places: a place that comes free takes the next item at
// once, where a batch would wait for its slowest item before starting any other. One thread of forty
// attachments then holds one place, and not the three beside it.
//
// `landed` is handed each result as its item ends, one at a time and in the order they end, so it can
// fold the result into the state and save it without two saves crossing. Answering `false` starts
// nothing more: what is in progress still ends, and still lands.
export type Landed<T, R> = (item: T, result: R) => Promise<boolean>;

export const inPool = async <T, R>(items: ReadonlyArray<T>, places: number, work: (item: T) => Promise<R>, landed: Landed<T, R>): Promise<void> => {
  let next = 0;
  let open = true;
  let landing: Promise<void> = Promise.resolve();
  const land = async (item: T, result: R): Promise<void> => {
    if (!(await landed(item, result))) open = false;
  };
  const place = async (): Promise<void> => {
    while (open && next < items.length) {
      const item = items[next] as T;
      next += 1;
      const result = await work(item);
      landing = landing.then(() => land(item, result));
      await landing;
    }
  };
  await Promise.all(Array.from({ length: places }, place));
};
