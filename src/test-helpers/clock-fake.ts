import type { Clock } from '../use-cases/ports/clock.ts';

export const createClockFake = (nowIso = '2026-07-23T14:00:00Z'): Clock => ({ nowIso: () => nowIso });
