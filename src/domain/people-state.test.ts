import { describe, expect, it } from 'bun:test';
import type { Colleague } from './directory.ts';
import { PEOPLE_ID, PEOPLE_NAME, emptyPeopleState, parsePeopleState, peopleWorklist, planPersonFiles, serializePeopleState, withPerson, withoutPerson } from './people-state.ts';
import type { Person } from './person.ts';

const person = (id: string, name: string): Person => ({ id, name, title: '', department: '', email: '', phones: [], office: '', enabled: true, member: true, manager: undefined });

const colleague = (id: string, name: string, fingerprint: string): Colleague => ({ person: person(id, name), teams: [], reports: [], fingerprint });

const seeded = (): ReturnType<typeof emptyPeopleState> =>
  withPerson(withPerson(emptyPeopleState(), 'jane', { file: 'kb/People/Jane Doe.md', name: 'Jane Doe', fingerprint: 'f-jane' }), 'dana', {
    file: 'kb/People/Dana Farrow.md',
    name: 'Dana Farrow',
    fingerprint: 'f-dana',
  });

describe('what a people run remembers between runs', () => {
  it('the directory is one source, named for what it is, standing beside the mailbox rather than under a heading', () => {
    expect(emptyPeopleState()).toEqual({ version: 1, source: { kind: 'people', id: PEOPLE_ID, name: PEOPLE_NAME }, lastRun: '', people: {} });
  });

  it('a person written once is found again by their id, with the file and the fingerprint they were written with', () => {
    expect(seeded().people['jane']).toEqual({ file: 'kb/People/Jane Doe.md', name: 'Jane Doe', fingerprint: 'f-jane' });
    expect(Object.keys(withoutPerson(seeded(), 'jane').people)).toEqual(['dana']);
  });

  it('a state written and read back is the state that was written', () => {
    expect(parsePeopleState(JSON.parse(serializePeopleState(seeded())))).toEqual({ ok: true, value: seeded() });
  });

  it('a state written by another version, or for another kind of source, is refused rather than half understood', () => {
    expect(parsePeopleState({ version: 4, source: { kind: 'people', id: 'people', name: 'People' } })).toEqual({
      ok: false,
      error: { kind: 'malformed', message: 'state is version 4, not 1' },
    });
    expect(parsePeopleState({ version: 1, source: { kind: 'mailbox', id: 'me', name: 'Mailbox' } })).toEqual({
      ok: false,
      error: { kind: 'malformed', message: 'state is not the people directory' },
    });
    expect(parsePeopleState(7)).toEqual({ ok: false, error: { kind: 'malformed', message: 'state is not an object' } });
  });

  it('a state with fields missing reads back as blanks, never as holes', () => {
    expect(parsePeopleState({ version: 1, source: { kind: 'people' }, people: { jane: { file: 'f' }, bad: 'x' } })).toEqual({
      ok: true,
      value: { version: 1, source: { kind: 'people', id: PEOPLE_ID, name: PEOPLE_NAME }, lastRun: '', people: { jane: { file: 'f', name: '', fingerprint: '' } } },
    });
  });
});

describe('deciding what a people run owes', () => {
  it('a newcomer is written, a person whose profile has not changed is left alone, and one whose profile changed is written again', () => {
    const work = peopleWorklist(seeded(), [colleague('jane', 'Jane Doe', 'f-jane'), colleague('dana', 'Dana Farrow', 'f-dana-promoted'), colleague('ann', 'Ann Lee', 'f-ann')]);

    expect(work.write.map((entry) => entry.person.id)).toEqual(['dana', 'ann']);
    expect(work.archive).toHaveLength(0);
  });

  it('a person no longer in the directory is put aside, named by the file they left behind', () => {
    const work = peopleWorklist(seeded(), [colleague('jane', 'Jane Doe', 'f-jane')]);

    expect(work.archive).toEqual([{ id: 'dana', record: { file: 'kb/People/Dana Farrow.md', name: 'Dana Farrow', fingerprint: 'f-dana' } }]);
  });

  it('a person the rosters still name but whose profile could not be read is left where they are, not put aside', () => {
    const work = peopleWorklist(seeded(), [colleague('jane', 'Jane Doe', 'f-jane')], ['dana']);

    expect(work.archive).toHaveLength(0);
  });
});

describe('deciding where each person about to be written goes', () => {
  it('a person is filed under their name, and two who share one are kept apart by their ids', () => {
    const twins = [colleague('one', 'Jane Doe', 'a'), colleague('two', 'Jane Doe', 'b')];

    const files = planPersonFiles('kb/People', twins, emptyPeopleState()).map((planned) => planned.file);

    expect(files[0]).toBe('kb/People/Jane Doe.md');
    expect(files[1]).not.toBe(files[0]);
    expect(files[1]).toContain('Jane Doe-');
  });

  it('a file held by a person nobody is rewriting is not handed to a namesake, and a person keeps their own file when only their old copy holds it', () => {
    const held = withPerson(emptyPeopleState(), 'sitting', { file: 'kb/People/Jane Doe.md', name: 'Jane Doe', fingerprint: 'x' });
    expect(planPersonFiles('kb/People', [colleague('newcomer', 'Jane Doe', 'a')], held)[0]?.file).not.toBe('kb/People/Jane Doe.md');

    const own = withPerson(emptyPeopleState(), 'jane', { file: 'kb/People/Jane Doe.md', name: 'Jane Doe', fingerprint: 'old' });
    expect(planPersonFiles('kb/People', [colleague('jane', 'Jane Doe', 'new')], own)[0]?.file).toBe('kb/People/Jane Doe.md');
  });
});
