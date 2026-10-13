import { indexDay, relativeTo, renderIndexPage } from './index-page.ts';
import type { ChannelState } from './team-state.ts';
import { compareText } from './utilities/compare-text.ts';

// A channel as a reader scans it: the post with the latest activity first, under the day of that
// activity, by its title and who wrote it. Two posts at one moment keep the order of their ids, so the
// page does not change between runs that changed nothing.
export const channelIndexPage = (channelName: string, channelRoot: string, channel: ChannelState | undefined, zone: string): string => {
  const rows = Object.entries(channel?.posts ?? {})
    .toSorted(([leftId, left], [rightId, right]) => compareText(right.lastModified, left.lastModified) || compareText(leftId, rightId))
    .map(([, record]) => ({ day: indexDay(record.lastModified, zone), title: record.title, file: relativeTo(channelRoot, record.file), note: record.from ?? '' }));
  return renderIndexPage(channelName, [{ heading: 'By last activity', rows }]);
};
