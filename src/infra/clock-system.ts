import type { Clock } from '../use-cases/ports/clock.ts';

export const createSystemClock = (): Clock => ({ nowIso: () => new Date().toISOString() });
