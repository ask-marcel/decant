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

  it('a block with no address to join by goes with no line in its place', () => {
    const old = [RULE, 'Join Microsoft Teams Meeting', 'Conference ID: 123 456 789#', RULE, 'After.'].join('\n');

    expect(withoutJoinBlocks(old, (url) => `Online meeting: ${url}`)).toBe('After.');
  });
});
