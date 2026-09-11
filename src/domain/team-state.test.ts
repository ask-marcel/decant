import { describe, expect, it } from 'bun:test';
import type { ChannelPost } from './channel-post.ts';
import { channelWork, emptyTeamState, parseTeamState, planPostFiles, serializeTeamState, teamRootName, withChannelCursor, withPost, withoutPost } from './team-state.ts';

const post = (id: string, lastModified: string, over: Partial<ChannelPost> = {}): ChannelPost => ({
  id,
  subject: `Post ${id}`,
  author: 'Jane Doe',
  created: lastModified,
  lastModified,
  deleted: false,
  webUrl: '',
  preview: '',
  ...over,
});

const CHANNEL = '19:gen@thread.tacv2';

const seeded = (): ReturnType<typeof emptyTeamState> =>
  withPost(
    withPost(withChannelCursor(emptyTeamState('team-1', 'MOOV Leadership'), CHANNEL, 'General', 'https://graph/delta?token=1'), CHANNEL, 'General', 'a', {
      file: 'kb/Teams/MOOV Leadership/General/2026-09-01/Post a.md',
      lastModified: '2026-09-01T09:00:00Z',
      title: 'Post a',
    }),
    CHANNEL,
    'General',
    'b',
    {
      file: 'kb/Teams/MOOV Leadership/General/2026-09-02/Post b.md',
      lastModified: '2026-09-02T09:00:00Z',
      title: 'Post b',
    }
  );

describe('what a team run remembers between runs', () => {
  it('a team is shelved under the same heading the picker offered it under', () => {
    expect(String(teamRootName('MOOV Leadership'))).toBe('Teams/MOOV Leadership');
  });

  it('an empty state names the team and holds no channel yet', () => {
    expect(emptyTeamState('team-1', 'MOOV Leadership')).toEqual({ version: 1, source: { kind: 'team', id: 'team-1', name: 'MOOV Leadership' }, lastRun: '', channels: {} });
  });

  it('a channel remembers its name, where its delta stands, and every post it wrote', () => {
    expect(seeded().channels[CHANNEL]).toEqual({
      name: 'General',
      deltaLink: 'https://graph/delta?token=1',
      posts: {
        a: { file: 'kb/Teams/MOOV Leadership/General/2026-09-01/Post a.md', lastModified: '2026-09-01T09:00:00Z', title: 'Post a' },
        b: { file: 'kb/Teams/MOOV Leadership/General/2026-09-02/Post b.md', lastModified: '2026-09-02T09:00:00Z', title: 'Post b' },
      },
    });
  });

  it('a post forgotten leaves the rest of its channel where it was, and a cursor moved keeps the posts', () => {
    expect(Object.keys(withoutPost(seeded(), CHANNEL, 'a').channels[CHANNEL]?.posts ?? {})).toEqual(['b']);
    expect(Object.keys(withChannelCursor(seeded(), CHANNEL, 'General', 'https://graph/delta?token=2').channels[CHANNEL]?.posts ?? {})).toEqual(['a', 'b']);
  });

  it('a state written and read back is the state that was written', () => {
    expect(parseTeamState(JSON.parse(serializeTeamState(seeded())))).toEqual({ ok: true, value: seeded() });
  });

  it('a state written by another version, or for another kind of source, is refused rather than half understood', () => {
    expect(parseTeamState({ version: 9, source: { kind: 'team', id: 't', name: 'n' } })).toEqual({ ok: false, error: { kind: 'malformed', message: 'state is version 9, not 1' } });
    expect(parseTeamState({ version: 1, source: { kind: 'site', id: 't', name: 'n' } })).toEqual({ ok: false, error: { kind: 'malformed', message: 'state is not a team' } });
    expect(parseTeamState(undefined)).toEqual({ ok: false, error: { kind: 'malformed', message: 'state is not an object' } });
  });

  it('a state with fields missing reads back as blanks, never as holes', () => {
    expect(parseTeamState({ version: 1, source: { kind: 'team' }, channels: { [CHANNEL]: { posts: { a: { file: 'f' }, bad: 7 } }, nope: 'x' } })).toEqual({
      ok: true,
      value: {
        version: 1,
        source: { kind: 'team', id: '', name: '' },
        lastRun: '',
        channels: { [CHANNEL]: { name: '', posts: { a: { file: 'f', lastModified: '', title: '' } } } },
      },
    });
  });
});

describe('deciding what a channel run owes', () => {
  it('a post the ledger has never seen is written, and one that has not changed since is left alone', () => {
    const work = channelWork(seeded(), CHANNEL, [post('a', '2026-09-01T09:00:00Z'), post('c', '2026-09-03T09:00:00Z')]);

    expect(work.write.map((entry) => entry.id)).toEqual(['c']);
    expect(work.archive).toHaveLength(0);
  });

  it('a post edited or replied to since it was written is written again, oldest change first', () => {
    const work = channelWork(seeded(), CHANNEL, [post('b', '2026-09-05T09:00:00Z'), post('a', '2026-09-04T09:00:00Z')]);

    expect(work.write.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('a post Graph has deleted is put aside if it was ever written, and ignored if it never was', () => {
    const work = channelWork(seeded(), CHANNEL, [post('a', '2026-09-06T09:00:00Z', { deleted: true }), post('zzz', '2026-09-06T09:00:00Z', { deleted: true })]);

    expect(work.write).toHaveLength(0);
    expect(work.archive).toEqual([{ id: 'a', record: { file: 'kb/Teams/MOOV Leadership/General/2026-09-01/Post a.md', lastModified: '2026-09-01T09:00:00Z', title: 'Post a' } }]);
  });

  it('a channel the ledger has never seen owes every post', () => {
    expect(channelWork(emptyTeamState('t', 'n'), CHANNEL, [post('a', '2026-09-01T09:00:00Z')]).write).toHaveLength(1);
  });
});

describe('deciding where each post about to be written goes', () => {
  it('a post is filed under its channel and the day it last changed, named by its title', () => {
    const [planned] = planPostFiles('kb/Teams/MOOV Leadership/General', [post('a', '2026-09-08T16:20:11Z', { subject: 'Venue' })], emptyTeamState('t', 'n'), CHANNEL);

    expect(planned?.file).toBe('kb/Teams/MOOV Leadership/General/2026-09-08/Venue.md');
  });

  it('two posts sharing a title and a day take different files, and a path a post nobody is rewriting holds is not handed out', () => {
    const twins = [post('one', '2026-09-08T16:20:11Z', { subject: 'Update' }), post('two', '2026-09-08T16:20:11Z', { subject: 'Update' })];
    const files = planPostFiles('kb/Teams/T/General', twins, emptyTeamState('t', 'n'), CHANNEL).map((planned) => planned.file);
    expect(files[0]).toBe('kb/Teams/T/General/2026-09-08/Update.md');
    expect(files[1]).not.toBe(files[0]);

    const held = withPost(emptyTeamState('t', 'n'), CHANNEL, 'General', 'sitting', { file: 'kb/Teams/T/General/2026-09-08/Update.md', lastModified: 'x', title: 'Update' });
    expect(planPostFiles('kb/Teams/T/General', [twins[0]!], held, CHANNEL)[0]?.file).not.toBe('kb/Teams/T/General/2026-09-08/Update.md');
  });

  it('a post keeps its plain path when the only thing holding it is the copy this run replaces', () => {
    const held = withPost(emptyTeamState('t', 'n'), CHANNEL, 'General', 'a', { file: 'kb/Teams/T/General/2026-09-08/Venue.md', lastModified: 'old', title: 'Venue' });

    expect(planPostFiles('kb/Teams/T/General', [post('a', '2026-09-08T16:20:11Z', { subject: 'Venue' })], held, CHANNEL)[0]?.file).toBe('kb/Teams/T/General/2026-09-08/Venue.md');
  });
});
