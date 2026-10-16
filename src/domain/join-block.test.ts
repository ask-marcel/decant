import { describe, expect, it } from 'bun:test';
import { withoutJoinBlocks } from './join-block.ts';

const JOIN = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%7d';
const RULE = '_'.repeat(80);
const ESCAPED_RULE = '\\_'.repeat(80);

// The block Teams writes into the body of each invitation, as a calendar event's body reads once its
// markup is gone.
const TEAMS = [
  RULE,
  'Microsoft Teams [Need help?](https://aka.ms/JoinTeamsMeeting?omkt=en-US)',
  `[Join the meeting now](${JOIN})`,
  'Meeting ID: 123 456 789 012',
  'Passcode: aB3cD4',
  'Dial in by phone',
  '[+1 555-0100,,123456#](tel:+15550100,,123456#) United States, Seattle',
  '[Find a local number](https://dialin.teams.microsoft.com/abc)',
  'Phone conference ID: 123 456 789#',
  'For organizers: [Meeting options](https://teams.microsoft.com/meetingOptions/?x=1) | [Reset dial-in PIN](https://dialin.teams.microsoft.com/usp/pstnconferencing)',
  RULE,
];

describe('the join block a meeting invitation carries', () => {
  it('a Teams block between its two rules goes, and the words around it stay', () => {
    expect(withoutJoinBlocks(['Let us review the budget.', ...TEAMS, 'Bring the figures.'].join('\n'))).toBe('Let us review the budget.\nBring the figures.');
  });

  // A mail's body is markdown, where each underscore of a rule is escaped and blank lines part the lines.
  it('a Teams block in a mail, with its escaped rules, can stand as one line naming where to join', () => {
    const mail = [
      'Let us review the budget.',
      '',
      ESCAPED_RULE,
      '',
      '**Microsoft Teams** [Need help?](https://aka.ms/x)',
      '',
      `[Join the meeting now](${JOIN})`,
      '',
      'Meeting ID: 123 456 789 012',
      '',
      ESCAPED_RULE,
      '',
      'Bring the figures.',
    ].join('\n');

    expect(withoutJoinBlocks(mail, (url) => `Online meeting: ${url}`)).toBe(`Let us review the budget.\n\nOnline meeting: ${JOIN}\n\nBring the figures.`);
  });

  it('a Google Meet block between its rules goes', () => {
    const rule = `-${':~'.repeat(30)}::-`;
    const meet = [
      'Agenda below.',
      rule,
      'Join with Google Meet: https://meet.google.com/abc-defg-hij',
      'Or dial: (US) +1 555-0100 PIN: 123456789#',
      'Please do not edit this section.',
      rule,
    ].join('\n');

    expect(withoutJoinBlocks(meet, (url) => `Online meeting: ${url}`)).toBe('Agenda below.\nOnline meeting: https://meet.google.com/abc-defg-hij');
  });

  it('a Zoom block goes from where it opens to the line that sends you to the local numbers', () => {
    const zoom = [
      'Jane Doe is inviting you to a scheduled Zoom meeting.',
      '',
      'Join Zoom Meeting',
      'https://us02web.zoom.us/j/12345678901?pwd=abc',
      '',
      'Meeting ID: 123 4567 8901',
      'Passcode: 123456',
      '---',
      'Dial by your location',
      '+1 555 0100 US',
      '',
      'Find your local number: https://us02web.zoom.us/u/abc',
      '',
      'See you there.',
    ].join('\n');

    expect(withoutJoinBlocks(zoom)).toBe('Jane Doe is inviting you to a scheduled Zoom meeting.\n\nSee you there.');
  });

  // A passcode, a rule or a block of text between rules is content anywhere else: a signature, a note
  // with a code in it, a line under a heading.
  it('keeps what only looks like a block: rules around other words, a rule never closed, a passcode on its own', () => {
    const signature = ['Thanks,', RULE, 'Jane Doe | Contoso', RULE].join('\n');
    const open = ['Notes', RULE, 'Meeting ID: 123'].join('\n');
    const zoom = ['Join Zoom Meeting', 'https://us02web.zoom.us/j/1', 'Passcode: 1'].join('\n');

    expect(withoutJoinBlocks(signature)).toBe(signature);
    expect(withoutJoinBlocks(open)).toBe(open);
    expect(withoutJoinBlocks(zoom)).toBe(zoom);
    expect(withoutJoinBlocks('Passcode: aB3cD4 opens the safe.')).toBe('Passcode: aB3cD4 opens the safe.');
  });

  // Only a link to join, or a line that opens with the meeting's ID, tells a block from words a sender
  // put between two rules.
  it('keeps words between two rules that only name Teams or a meeting ID', () => {
    const agenda = [RULE, '1. Microsoft Teams rollout', '2. Budget', RULE].join('\n');
    const signature = ['Thanks,', RULE, 'Chat with me on Microsoft Teams', RULE].join('\n');
    const question = [RULE, 'Could you send the meeting ID for Thursday?', RULE].join('\n');

    expect(withoutJoinBlocks(agenda)).toBe(agenda);
    expect(withoutJoinBlocks(signature)).toBe(signature);
    expect(withoutJoinBlocks(question)).toBe(question);
  });

  // Teams puts a shorter rule inside its block, before the dial-in numbers, and a reply quoted under a
  // mail can open with one: only a rule like the one that opened a block closes it.
  it('a Teams block runs to the rule like the one that opened it, past a shorter rule', () => {
    const block = [
      RULE,
      'Microsoft Teams Need help?',
      `[Join the meeting now](${JOIN})`,
      'Meeting ID: 123 456 789 012',
      'Passcode: aB3cD4',
      '_'.repeat(40),
      'Dial in by phone',
      '+1 555-0100,,123456789# United States, Seattle',
      'Phone conference ID: 123 456 789#',
      'For organizers: Meeting options | Reset dial-in PIN',
      RULE,
    ];
    const open = [RULE, 'Microsoft Teams Need help?', `[Join the meeting now](${JOIN})`, 'Agenda: the budget.', '_'.repeat(32), 'From: Jane Doe'].join('\n');

    expect(withoutJoinBlocks(['Agenda below.', ...block, 'Bring the figures.'].join('\n'))).toBe('Agenda below.\nBring the figures.');
    expect(withoutJoinBlocks(open)).toBe(open);
  });

  // A second invitation that opens first means the one before it never reached its local numbers.
  it('a Zoom block runs no further than the next invitation', () => {
    const first = ['Join Zoom Meeting', 'https://us02web.zoom.us/j/1', 'Agenda: the budget.'];
    const second = ['Join Zoom Meeting', 'https://us02web.zoom.us/j/2', 'Meeting ID: 2', 'Find your local number: https://us02web.zoom.us/u/abc'];

    expect(withoutJoinBlocks([...first, ...second, 'See you.'].join('\n'))).toBe([...first, 'See you.'].join('\n'));
  });

  // A link this code does not know is still the way into the meeting, so a block asked to leave its
  // link and holding none it knows stays whole; asked for nothing, it goes.
  it('a block with no link to join it knows stays whole when its link is asked for, and goes when not', () => {
    const old = [RULE, 'Join Microsoft Teams Meeting', 'Conference ID: 123 456 789#', RULE, 'After.'].join('\n');

    expect(withoutJoinBlocks(old, (url) => `Online meeting: ${url}`)).toBe(old);
    expect(withoutJoinBlocks(old)).toBe('After.');
  });

  // Since 2026 Teams writes the short link itself as the link's text, where a mail's markdown escapes
  // each underscore, so the link is read where it goes.
  it('a Teams block of the short link form stands as that link, read where it goes, for work and for personal use', () => {
    const short = 'https://teams.microsoft.com/meet/123456789012?p=ab_Cd';
    const mail = [
      ESCAPED_RULE,
      '',
      '**Microsoft Teams** [Need help?](https://aka.ms/x)',
      '',
      `[${short.replace('_', '\\_')}](${short})`,
      '',
      'Meeting ID: 123 456 789 012',
      '',
      ESCAPED_RULE,
    ].join('\n');
    const personal = [RULE, 'Microsoft Teams', 'Join: https://teams.live.com/meet/9312345678901?p=AbCd', 'Meeting ID: 931 234 567 890 1', RULE].join('\n');

    expect(withoutJoinBlocks(mail, (url) => `Online meeting: ${url}`)).toBe(`Online meeting: ${short}`);
    expect(withoutJoinBlocks(personal, (url) => `Online meeting: ${url}`)).toBe('Online meeting: https://teams.live.com/meet/9312345678901?p=AbCd');
  });
});
