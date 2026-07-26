// Reports how far a long conversion has got, so a run that would otherwise sit silent for minutes
// shows what it is doing. Purely presentational: it never changes what lands on disk, and a no-op
// implementation is always a valid choice (a run piped to a file wants no moving counter).
export type Progress = {
  // Begin counting `total` items of one kind (e.g. 'Converting'). Resets the count to zero.
  readonly start: (total: number, what: string) => void;
  // One item's IO has started, named for the reader. The visible count does not move: this is what
  // lets the line still name a slow item once its faster window-siblings have each stepped past it.
  readonly begin: (label: string) => void;
  // One more item is done, named for the reader. The visible count moves by one.
  readonly step: (label: string) => void;
  // The run is over; the line is closed so whatever prints next starts clean.
  readonly done: () => void;
};
