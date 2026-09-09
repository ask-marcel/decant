import { describe, expect, it } from 'bun:test';
import { renderTaskDocument } from './todo-document.ts';
import type { TodoTask } from './todo-task.ts';

const task: TodoTask = {
  id: 'AAMkAGI-task',
  title: 'Book the venue',
  status: 'completed',
  importance: 'high',
  notes: 'Ask for the September rate.',
  created: '2026-08-01T09:00:00Z',
  lastModified: '2026-09-08T16:20:11Z',
  due: '2026-09-12',
  completed: '2026-09-08',
  categories: ['Work'],
  steps: [
    { text: 'Shortlist three', done: true },
    { text: 'Call them', done: false },
  ],
  links: [{ name: 'Contract draft', url: 'https://tenant.sharepoint.com/sites/X/Contract.docx', application: 'Microsoft Word' }],
};

const bare: TodoTask = {
  id: 'AAMkAGI-bare',
  title: 'Water the plants',
  status: 'notStarted',
  importance: 'normal',
  notes: '',
  created: '',
  lastModified: '',
  due: '',
  completed: '',
  categories: [],
  steps: [],
  links: [],
};

const rendered = (subject: TodoTask): string => renderTaskDocument({ task: subject, list: 'Tasks', syncedAt: '2026-09-09T14:00:00Z' });

describe('writing one To Do task as a document', () => {
  it('a task opens with where it came from and what it is, then says what it says', () => {
    expect(rendered(task)).toBe(
      [
        '---',
        'source: To Do - Tasks',
        'list: Tasks',
        'status: completed',
        'importance: high',
        'due: "2026-09-12"',
        'completed: "2026-09-08"',
        'created: "2026-08-01T09:00:00Z"',
        'last_modified: "2026-09-08T16:20:11Z"',
        'categories:',
        '  - Work',
        'synced_at: "2026-09-09T14:00:00Z"',
        '---',
        '',
        '# Book the venue',
        '',
        'Ask for the September rate.',
        '',
        '## Steps',
        '',
        '- [x] Shortlist three',
        '- [ ] Call them',
        '',
        '## Links',
        '',
        '- [Contract draft](https://tenant.sharepoint.com/sites/X/Contract.docx)',
        '',
      ].join('\n')
    );
  });

  it('a task with no notes, no steps and no links carries none of those headings, rather than empty ones', () => {
    const written = rendered(bare);

    expect(written).not.toContain('## Steps');
    expect(written).not.toContain('## Links');
    expect(written.endsWith('# Water the plants\n')).toBe(true);
  });

  it('an ordinary task says nothing about its importance, so the word only ever appears where it means something', () => {
    expect(rendered(bare)).not.toContain('importance:');
    expect(rendered({ ...bare, importance: 'low' })).toContain('importance: low');
  });

  it('a link with no name of its own is named by the application that wrote it, rather than reading as an empty label', () => {
    expect(rendered({ ...bare, links: [{ name: '', url: 'https://example.com/deck', application: 'Microsoft Word' }] })).toContain('- [Microsoft Word](https://example.com/deck)');
  });
});
