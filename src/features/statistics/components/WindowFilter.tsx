import { SegmentedControl } from '@/ui';

import { WINDOW_OPTIONS } from '../domain/windows';
import { useStatsWindow } from '../hooks/useStatistics';

/** The 7 days / 30 days / 90 days / All time filter, remembered while the app runs. */
export function WindowFilter() {
  const [window, setWindow] = useStatsWindow();
  return (
    <SegmentedControl
      accessibilityLabel="Time period"
      options={WINDOW_OPTIONS}
      value={window}
      onChange={setWindow}
    />
  );
}
