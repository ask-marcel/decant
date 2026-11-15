import { describe, expect, it } from 'bun:test';
import { parseChatMessage, pictureMarker } from './chat-message.ts';

// One entry of `list-teams-chat-history` in its default projection, as the library answers it.
const substrateMessage = {
  id: '1794536130123',
  sequenceId: 41,
  composetime: '2026-11-13T02:15:30.1230000Z',
  originalarrivaltime: '2026-11-13T02:15:31.4560000Z',
  messagetype: 'RichText/Html',
  from: 'https://teams.microsoft.com/api/chatsvc/emea/v1/users/ME/contacts/8:orgid:0000-jane',
  imdisplayname: 'Jane Doe',
  content: '<p>Here is the budget, see <a href="https://example.com/plan">the plan</a>.</p>',
  webUrl: 'https://teams.microsoft.com/l/message/19%3Aabc%40thread.v2/1794536130123',
  files: [
    {
      name: 'Budget.xlsx',
      type: 'xlsx',
      url: 'https://contoso-my.sharepoint.com/personal/jane_contoso_com/Documents/Microsoft Teams Chat Files/Budget.xlsx',
      shareUrl: 'https://contoso-my.sharepoint.com/:x:/g/personal/jane_contoso_com/EaBcD',
    },
  ],
};

const pasted = (source: string): string =>
  `<img itemscope="image" style="vertical-align:bottom" src="${source}" alt="image" width="250" height="140" itemtype="http://schema.skype.com/AMSImage">`;

const FIRST = 'https://eu-api.asm.skype.com/v1/objects/0-weu-d1-aaa/views/imgo';
const SECOND = 'https://eu-api.asm.skype.com/v1/objects/0-weu-d1-bbb/views/imgo?v=1&amp;size=full';

describe('reading a chat message as the Teams substrate answers for it', () => {
  it('a message of a person keeps its id, who wrote it, when, what it says, and the files it shared', () => {
    expect(parseChatMessage(substrateMessage)).toEqual({
      id: '1794536130123',
      author: 'Jane Doe',
      sent: '2026-11-13T02:15:30.1230000Z',
      text: 'Here is the budget, see [the plan](https://example.com/plan).',
      files: [{ name: 'Budget.xlsx', url: 'https://contoso-my.sharepoint.com/:x:/g/personal/jane_contoso_com/EaBcD' }],
      pictures: 0,
      webUrl: 'https://teams.microsoft.com/l/message/19%3Aabc%40thread.v2/1794536130123',
    });
  });

  it('a file with no sharing link is reached by its own address, and a plain-text message is kept as it was typed', () => {
    const message = parseChatMessage({
      ...substrateMessage,
      messagetype: 'Text',
      content: 'budget < 5 & rising',
      files: [{ name: 'Notes.docx', url: 'https://contoso.sharepoint.com/sites/Finance/Shared Documents/Notes.docx' }, { type: 'pdf' }],
    });

    expect(message?.text).toBe('budget < 5 & rising');
    expect(message?.files).toEqual([{ name: 'Notes.docx', url: 'https://contoso.sharepoint.com/sites/Finance/Shared Documents/Notes.docx' }]);
  });

  it('a call, a member added, or any other entry the client wrote is not a message', () => {
    expect(parseChatMessage({ ...substrateMessage, messagetype: 'Event/Call', event: 'call-started' })).toBeUndefined();
    expect(parseChatMessage({ ...substrateMessage, messagetype: 'ThreadActivity/AddMember', event: 'member-added' })).toBeUndefined();
    expect(parseChatMessage({ ...substrateMessage, id: undefined })).toBeUndefined();
    expect(parseChatMessage('1794536130123')).toBeUndefined();
  });

  it('a message with no words, no file and no picture, which is what a deleted one leaves, is left out', () => {
    expect(parseChatMessage({ ...substrateMessage, content: '', files: undefined })).toBeUndefined();
    expect(parseChatMessage({ ...substrateMessage, content: '<p>&nbsp;</p>', files: [] })).toBeUndefined();
    expect(parseChatMessage({ ...substrateMessage, content: '', files: undefined, imdisplayname: undefined, composetime: undefined })).toBeUndefined();
  });

  it('a message of only a file, or only a picture, is kept', () => {
    expect(parseChatMessage({ ...substrateMessage, content: '' })?.files).toHaveLength(1);
    expect(parseChatMessage({ ...substrateMessage, content: pasted(FIRST), files: undefined })?.pictures).toBe(1);
  });

  it('each different pasted picture stands as a marker in its place, in the order the library hands the pictures back', () => {
    const content = `<p>Before</p><p>${pasted(FIRST)}</p><p>Between ${pasted(SECOND)} and again ${pasted(FIRST)}</p>`;

    const message = parseChatMessage({ ...substrateMessage, content, files: undefined });

    expect(message?.pictures).toBe(2);
    expect(message?.text).toBe(`Before\n${pictureMarker(0)}\nBetween ${pictureMarker(1)} and again ${pictureMarker(0)}`);
  });

  it('an emoji reads as its character, a mention as the name, and any other picture as a link to it', () => {
    const emoji =
      '<span class="animated-emoticon-20-smile" title="Smile"><img itemscope itemtype="http://schema.skype.com/Emoji" itemid="smile" src="https://statics.teams.cdn.office.net/evergreen-assets/smile.png" alt="🙂" style="width:20px"></span>';
    const mention = '<span itemscope itemtype="http://schema.skype.com/Mention" itemid="0">Li Wei</span>';
    const other = '<img src="https://example.com/chart.png" alt="chart">';
    const nameless = '<img itemtype="http://schema.skype.com/Emoji" src="https://statics.teams.cdn.office.net/evergreen-assets/wave.png">';

    const message = parseChatMessage({ ...substrateMessage, content: `<p>${mention} thanks ${emoji}${nameless} ${other}</p>`, files: undefined });

    expect(message?.text).toBe('Li Wei thanks 🙂 [chart](https://example.com/chart.png)');
    expect(message?.pictures).toBe(0);
  });

  it('something that is no message at all, or a message whose id is not text, is left out without a word', () => {
    expect(parseChatMessage(null)).toBeUndefined();
    expect(parseChatMessage(undefined)).toBeUndefined();
    expect(parseChatMessage({ ...substrateMessage, id: 1794536130123 })).toBeUndefined();
  });

  it('a plain-text message keeps what was typed, a reference as its letters, with the space around it taken off', () => {
    expect(parseChatMessage({ ...substrateMessage, messagetype: 'Text', content: '  use &lt;div&gt; here \n', files: undefined })?.text).toBe('use &lt;div&gt; here');
    expect(parseChatMessage({ ...substrateMessage, content: 'use &lt;div&gt; here', files: undefined })?.text).toBe('use <div> here');
  });

  it('one picture written with `&amp;` and again with `&` in its address is one picture, as the library counts it', () => {
    const escaped = pasted('https://eu-api.asm.skype.com/v1/objects/0-weu-d1-ccc/views/imgo?v=1&amp;size=full');
    const plain = pasted('https://eu-api.asm.skype.com/v1/objects/0-weu-d1-ccc/views/imgo?v=1&size=full');

    const message = parseChatMessage({ ...substrateMessage, content: `<p>${escaped}${plain}</p>`, files: undefined });

    expect(message?.pictures).toBe(1);
    expect(message?.text).toBe('[[picture 1]][[picture 1]]');
    expect(pictureMarker(1)).toBe('[[picture 2]]');
  });

  it('a message with no content at all and one file has no words, and a file with a name and no address keeps its name', () => {
    const message = parseChatMessage({ ...substrateMessage, content: undefined, files: [{ name: 'Orphan.txt' }] });

    expect(message?.text).toBe('');
    expect(message?.files).toEqual([{ name: 'Orphan.txt', url: '' }]);
  });

  it('a message that names no writer and no time still lands, under words that say so', () => {
    const message = parseChatMessage({ id: '7', content: 'hello', messagetype: 'Text' });

    expect(message).toEqual({ id: '7', author: 'Unknown sender', sent: '', text: 'hello', files: [], pictures: 0, webUrl: '' });
  });

  it('a pasted picture with no address is not counted, since the library hands none back for it', () => {
    const message = parseChatMessage({ ...substrateMessage, content: '<p>Look <img itemtype="http://schema.skype.com/AMSImage" alt="image"></p>', files: undefined });

    expect(message?.pictures).toBe(0);
    expect(message?.text).toBe('Look');
  });

  it('the time the message arrived stands in when it carries no time it was written', () => {
    expect(parseChatMessage({ ...substrateMessage, composetime: undefined })?.sent).toBe('2026-11-13T02:15:31.4560000Z');
  });
});
