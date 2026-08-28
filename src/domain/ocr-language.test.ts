import { describe, expect, it } from 'bun:test';
import { scriptOf } from './ocr-language.ts';

const ENGLISH_PAGE = 'Unified authentication for the Contoso ecosystem. One identity, one login, secure access to every application we run.';
const CHINESE_PAGE = '公司年度会议将于下周举行，请各部门准时参加。';
const JAPANESE_PAGE = '社内お知らせ\n四半期ごとに優秀な社員を選出します。\n応募はチームリーダーが行ってください。';

describe('deciding which script a reading is in', () => {
  it('a page of Chinese is Chinese', () => {
    expect(scriptOf(CHINESE_PAGE)).toBe('chinese');
  });

  it('a page of Japanese is Japanese, told apart by its kana', () => {
    expect(scriptOf(JAPANESE_PAGE)).toBe('japanese');
  });

  it('an English page is Latin, so it can be read by the model that keeps word spacing', () => {
    expect(scriptOf(ENGLISH_PAGE)).toBe('latin');
  });

  it('one stray ideograph on an English page does not make the page Chinese', () => {
    expect(scriptOf(`${ENGLISH_PAGE} 中`)).toBe('latin');
  });

  it('one stray kana on a Chinese page does not make the page Japanese', () => {
    expect(scriptOf(`${CHINESE_PAGE}${CHINESE_PAGE}${CHINESE_PAGE}の`)).toBe('chinese');
  });

  it('a Chinese page carrying an English brand name is still Chinese', () => {
    expect(scriptOf('欢迎使用 Contoso 系统，请先登录。')).toBe('chinese');
  });

  it('a Chinese heading over a page that is otherwise blank is still Chinese', () => {
    expect(scriptOf(`会议纪要\n${' '.repeat(200)}\n`)).toBe('chinese');
  });

  it('a reading with no text at all is Latin', () => {
    expect(scriptOf('')).toBe('latin');
  });

  it('a reading of nothing but blank space is Latin', () => {
    expect(scriptOf('  \n  ')).toBe('latin');
  });
});
