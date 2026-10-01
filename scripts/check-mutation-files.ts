// The mutation gate breaks on the total of the files a run mutates, never per file, so a weak file
// passes while the others carry it (lessons.archive.md, 2026-08-30). Run after Stryker, this reads
// the report it just wrote and fails on any single file under the same break threshold.
//
//   bun run scripts/check-mutation-files.ts [report]   (default reports/mutation/mutation.json)

type Mutant = { readonly status: string };

export type MutationReport = { readonly files: Readonly<Record<string, { readonly mutants: ReadonlyArray<Mutant> }>> };

export type FileScore = { readonly file: string; readonly score: number; readonly detected: number; readonly valid: number };

// Stryker's own scoring: a kill or a timeout is caught, a survivor or a mutant no test reached is
// missed, and one that never ran (a compile or runtime error, an ignored one) counts for nothing.
const CAUGHT: ReadonlySet<string> = new Set(['Killed', 'Timeout']);
const MISSED: ReadonlySet<string> = new Set(['Survived', 'NoCoverage']);

const scoreOf = (file: string, mutants: ReadonlyArray<Mutant>): FileScore => {
  const detected = mutants.filter((mutant) => CAUGHT.has(mutant.status)).length;
  const valid = detected + mutants.filter((mutant) => MISSED.has(mutant.status)).length;
  return { file, score: (detected / valid) * 100, detected, valid };
};

export const filesUnder = (report: MutationReport, threshold: number): ReadonlyArray<FileScore> =>
  Object.entries(report.files)
    .map(([file, { mutants }]) => scoreOf(file, mutants))
    .filter((scored) => scored.valid > 0 && scored.score < threshold);

const main = async (): Promise<number> => {
  const config = (await Bun.file('stryker.conf.json').json()) as { readonly thresholds: { readonly break: number } };
  const threshold = config.thresholds.break;
  const under = filesUnder((await Bun.file(process.argv[2] ?? 'reports/mutation/mutation.json').json()) as MutationReport, threshold);
  if (under.length === 0) {
    console.log(`check-mutation-files: every mutated file is at or above the break of ${threshold}`);
    return 0;
  }
  console.log(`check-mutation-files: ${under.length} file(s) under the break of ${threshold}, which the total hides:`);
  for (const scored of under) console.log(`  ${scored.file}  ${scored.score.toFixed(2)}% (${scored.detected} of ${scored.valid} caught)`);
  return 1;
};

if (import.meta.main) process.exit(await main());
