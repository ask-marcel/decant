import { describe, expect, it } from 'bun:test';
import { holdsChineseText } from './ocr-language.ts';

const ENGLISH_PAGE = 'Unified authentication for the Contoso ecosystem. One identity, one login, secure access to every application we run.';

describe('deciding whether a reading is Chinese', () => {
  it('a page of Chinese is Chinese', () => {
    expect(holdsChineseText('公司年度会议将于下周举行，请各部门准时参加。')).toBe(true);
  });

  it('an English page is not Chinese, so it can be read again by the model that keeps word spacing', () => {
    expect(holdsChineseText(ENGLISH_PAGE)).toBe(false);
  });

  it('one stray ideograph on an English page does not make the page Chinese', () => {
    expect(holdsChineseText(`${ENGLISH_PAGE} 中`)).toBe(false);
  });

  it('a Chinese page carrying an English brand name is still Chinese', () => {
    expect(holdsChineseText('欢迎使用 Contoso 系统，请先登录。')).toBe(true);
  });

  it('a Chinese heading over a page that is otherwise blank is still Chinese', () => {
    expect(holdsChineseText(`会议纪要\n${' '.repeat(200)}\n`)).toBe(true);
  });

  it('a reading with no text at all is not Chinese', () => {
    expect(holdsChineseText('')).toBe(false);
  });

  it('a reading of nothing but blank space is not Chinese', () => {
    expect(holdsChineseText('  \n  ')).toBe(false);
  });
});
