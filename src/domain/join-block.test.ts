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

  // A mail's markdown escapes the dash that opens a line, and so the first dash of Meet's rule.
  it('a Google Meet block in a mail, its rules escaped, stands as one line naming where to join', () => {
    const rule = `\\-::~:~::~${':~'.repeat(35)}::~:~::-`;
    const mail = [
      'Agenda below.',
      '',
      rule,
      '',
      'Join with Google Meet: [https://meet.google.com/abc-defg-hij](https://meet.google.com/abc-defg-hij)',
      '',
      'Please do not edit this section.',
      '',
      rule,
    ].join('\n');

    expect(withoutJoinBlocks(mail, (url) => `Online meeting: ${url}`)).toBe('Agenda below.\n\nOnline meeting: https://meet.google.com/abc-defg-hij');
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

  // Past the local numbers Zoom can add ways to join by SIP, by H.323 and by Skype for Business, each a
  // heading and its addresses, the meeting ID again, between rules of dashes in the newer layout.
  it('a Zoom block runs on over the ways to join by SIP, H.323 or Skype that follow its local numbers', () => {
    const calendar = [
      'Agenda below.',
      'Join Zoom Meeting',
      '[https://us02web.zoom.us/j/12345678901](https://us02web.zoom.us/j/12345678901)',
      'Dial by your location',
      '+1 555 0100 US',
      'Meeting ID: 123 4567 8901',
      'Find your local number: [https://us02web.zoom.us/u/abc](https://us02web.zoom.us/u/abc)',
      'Join by SIP',
      '12345678901@zoomcrc.com',
      'Join by H.323',
      '192.0.2.11 (US West)',
      '198.51.100.11 (US East)',
      'Meeting ID: 123 4567 8901',
      'Join by Skype for Business',
      '[https://us02web.zoom.us/skype/12345678901](https://us02web.zoom.us/skype/12345678901)',
      'See you there.',
    ].join('\n');
    const zoom = 'https://us02web.zoom.us/j/12345678901?pwd=abc';
    const mail = [
      'Join Zoom Meeting',
      '',
      `[${zoom}](${zoom})`,
      '',
      'Find your local number: [https://us02web.zoom.us/u/abc](https://us02web.zoom.us/u/abc)',
      '',
      '\\---',
      '',
      'Join by H.323',
      '',
      '• 192.0.2.11 (US West)',
      '',
      'Meeting ID: 123 4567 8901  ',
      'Passcode: 123456',
      '',
      'See you there.',
    ].join('\n');

    expect(withoutJoinBlocks(calendar)).toBe('Agenda below.\nSee you there.');
    expect(withoutJoinBlocks(mail, (url) => `Online meeting: ${url}`)).toBe(`Online meeting: ${zoom}\n\nSee you there.`);
  });

  it('a Zoom block keeps a passcode a sender wrote after the local numbers, with no way to join before it', () => {
    const note = ['Agenda below.', 'Join Zoom Meeting', 'https://us02web.zoom.us/j/1', 'Find your local number: https://us02web.zoom.us/u/abc', 'Passcode for the door: 4321'].join(
      '\n'
    );

    expect(withoutJoinBlocks(note)).toBe('Agenda below.\nPasscode for the door: 4321');
  });

  // A calendar note holds the link Graph gives in its front matter, so a block with that link leaves
  // no line at all.
  it('a block whose link is held elsewhere goes with no line in its place', () => {
    const standIn = (url: string): string => (url === JOIN ? '' : `Online meeting: ${url}`);

    expect(withoutJoinBlocks([...TEAMS, 'Bring the figures.'].join('\n'), standIn)).toBe('Bring the figures.');
  });

  // A link this code does not know is still the way into the meeting, so a block asked to leave its
  // link and holding none it knows stays whole; asked for nothing, it goes.
  it('a block with no link to join it knows stays whole when its link is asked for, and goes when not', () => {
    const old = [RULE, 'Join Microsoft Teams Meeting', 'Conference ID: 123 456 789#', RULE, 'After.'].join('\n');

    const spaced = [RULE, 'Conference ID: 123 456 789#', RULE, '', '', 'After.'].join('\n');

    expect(withoutJoinBlocks(old, (url) => `Online meeting: ${url}`)).toBe(old);
    expect(withoutJoinBlocks(spaced, (url) => `Online meeting: ${url}`)).toBe(spaced);
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

  // Lines that only look like the edge of a block: words before or after a rule, an opening, an end or
  // an ID inside a sentence, a link outside the rules.
  it.each([
    ['words before a rule', ['Sign here: __________', `Join: ${JOIN}`, 'Sign here: __________']],
    ['words after a rule', ['__________ (signed)', `Join: ${JOIN}`, '__________ (signed)']],
    ['a word run into the start of a rule', ['x__________', `Join: ${JOIN}`, 'x__________']],
    ['a word run into the end of a rule', ['__________x', `Join: ${JOIN}`, '__________x']],
    ['words before a Meet rule', ['Cut here -:~:~:~:~:~:~-', `Join: ${JOIN}`, 'Cut here -:~:~:~:~:~:~-']],
    ['words after a Meet rule', ['-:~:~:~:~:~:~- cut here', `Join: ${JOIN}`, '-:~:~:~:~:~:~- cut here']],
    ['a word run into the start of a Meet rule', ['x-:~:~:~:~:~:~-', `Join: ${JOIN}`, 'x-:~:~:~:~:~:~-']],
    ['a word run into the end of a Meet rule', ['-:~:~:~:~:~:~-x', `Join: ${JOIN}`, '-:~:~:~:~:~:~-x']],
    ['a Zoom opening inside a sentence', ['Click to Join Zoom Meeting', 'https://us02web.zoom.us/j/1', 'Find your local number: https://us02web.zoom.us/u/abc']],
    ['a Zoom opening with words after it', ['Join Zoom Meeting at ten with the team', 'https://us02web.zoom.us/j/1', 'Find your local number: https://us02web.zoom.us/u/abc']],
    ['the local numbers named inside a sentence', ['Join Zoom Meeting', 'https://us02web.zoom.us/j/1', 'If you cannot find your local number, ask me.']],
    ['a meeting ID named inside a sentence', [RULE, 'Please note the new meeting ID: 555 0100', RULE]],
    ['rules around a signature, with a link to join outside them', [`Join: ${JOIN}`, 'Thanks,', RULE, 'Jane Doe | Contoso', RULE]],
    ['three blank lines and no block', ['Agenda below.', '', '', 'Bring the figures.']],
  ])('keeps %s', (_name, lines) => {
    const text = lines.join('\n');

    expect(withoutJoinBlocks(text)).toBe(text);
  });

  // What a sender wrote after a Zoom block stays, whatever the block holds past its local numbers.
  const H323 = ['Join by H.323', '192.0.2.11 (US West)'];
  it.each([
    ['a way to join they name', [], 'Or join by phone: +1 555 0100'],
    ['a passcode named inside a sentence', H323, 'The door passcode is 4321.'],
    ['an address inside a sentence', H323, 'Server 192.0.2.50 is down.'],
    ['a number that is no address', H323, '1.5 hours for questions.'],
  ])('a Zoom block leaves %s after it', (_name, tail, said) => {
    const block = ['Join Zoom Meeting', 'https://us02web.zoom.us/j/1', 'Find your local number: https://us02web.zoom.us/u/abc', ...tail];

    expect(withoutJoinBlocks([...block, said].join('\n'))).toBe(said);
  });

  // A mail's markdown puts Zoom's headings in bold and can make its line of local numbers a link.
  it('a Zoom block in a mail goes whole with its headings in bold, to the end of the text', () => {
    const zoom = 'https://us02web.zoom.us/j/12345678901?pwd=abc';
    const mail = [
      'Agenda below.',
      '',
      '**Join Zoom Meeting**',
      '',
      `[${zoom}](${zoom})`,
      '',
      '[Find your local number](https://us02web.zoom.us/u/abc)',
      '',
      '**Join by H.323**',
      '',
      '• 192.0.2.11 (US West)',
      '',
      '**Meeting ID:** 123 4567 8901',
    ].join('\n');

    expect(withoutJoinBlocks(mail, (url) => `Online meeting: ${url}`)).toBe(`Agenda below.\n\nOnline meeting: ${zoom}`);
  });

  // A rule can end in the spaces a line break leaves, more on one rule than on the other.
  it('a block between rules with spaces after them goes, and one whose only sign is an ID in bold', () => {
    const spaced = [`${ESCAPED_RULE}  `, '', `[Join the meeting now](${JOIN})`, '', `${ESCAPED_RULE} `, '', 'After.'].join('\n');
    const bold = [RULE, 'Microsoft Teams', '**Conference ID:** 123 456 789#', RULE, 'After.'].join('\n');

    expect(withoutJoinBlocks(spaced, (url) => `Online meeting: ${url}`)).toBe(`Online meeting: ${JOIN}\n\nAfter.`);
    expect(withoutJoinBlocks(bold)).toBe('After.');
  });

  it('a block kept for want of a link stays as it was beside one that goes', () => {
    const text = [RULE, `[Join the meeting now](${JOIN})`, RULE, 'Between.', RULE, 'Conference ID: 123 456 789#', RULE].join('\n');

    expect(withoutJoinBlocks(text, (url) => `Online meeting: ${url}`)).toBe([`Online meeting: ${JOIN}`, 'Between.', RULE, 'Conference ID: 123 456 789#', RULE].join('\n'));
  });
});
