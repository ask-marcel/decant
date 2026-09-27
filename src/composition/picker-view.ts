import {
  renderChannelPicker,
  renderLibraryPicker,
  renderReportPointer,
  renderSinceQuestion,
  renderSinceRefused,
  renderSitePicker,
  renderSourceFailed,
  renderSummary,
} from '../presenter/render-picker.ts';
import type { PickerView } from '../use-cases/ports/picker-view.ts';

// The presenter's words, handed to the run through its port.
export const pickerView: PickerView = {
  sitePicker: renderSitePicker,
  libraryPicker: renderLibraryPicker,
  channelPicker: renderChannelPicker,
  summary: renderSummary,
  sourceFailed: renderSourceFailed,
  reportPointer: renderReportPointer,
  sinceQuestion: renderSinceQuestion,
  sinceRefused: renderSinceRefused,
};
