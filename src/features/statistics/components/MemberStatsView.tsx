import { View } from 'react-native';

import type { MemberStatistics } from '@/lib/database.types';
import { Card, Icon, Text, useTheme } from '@/ui';

import { rateScale } from '../domain/chart';
import { EMPTY_STATS, MISSED_HELP, NOT_RECORDED_NOTE, RATE_NOTE, RELIABILITY_HELP, WALK_INS_HELP } from '../domain/copy';
import { formatCount, formatPercent, ofCount, smallSampleLabel } from '../domain/format';
import { axisLabels } from '../domain/periods';
import { monthlySummary } from '../domain/summaries';
import { BarChart } from './BarChart';
import { StatCard, StatGrid } from './StatCard';

/**
 * A member's participation: headline cards and the monthly chart. Used for
 * "My participation" and, by organizers, for another member (`subject` is
 * then their name and the wording follows).
 */
export function MemberStatsView({
  stats,
  subject,
}: {
  stats: MemberStatistics;
  /** Name of the member being viewed; omit for "my" statistics. */
  subject?: string;
}) {
  const { spacing } = useTheme();

  if (stats.eligible === 0) {
    return (
      <Card style={{ gap: spacing.sm, alignItems: 'center' }}>
        <Icon name="chart" size={28} color="textMuted" />
        <Text variant="heading" align="center">
          No finalized events
        </Text>
        <Text color="textMuted" align="center">
          {EMPTY_STATS}
        </Text>
      </Card>
    );
  }

  const rateSample = smallSampleLabel(stats.eligible);
  const reliabilitySample = smallSampleLabel(stats.rsvp_going_recorded);
  const months = stats.monthly;
  // Months with no eligible training stay in the series as empty slots.
  const rates = months.map((month) => (month.eligible > 0 ? month.attendance_rate : null));

  return (
    <View style={{ gap: spacing.lg }}>
      <View style={{ gap: spacing.sm }}>
        <StatGrid>
          <StatCard
            label="Attendance rate"
            value={formatPercent(stats.attendance_rate)}
            detail={ofCount(stats.attended, stats.eligible)}
            note={rateSample}
          />
          <StatCard
            label="Not recorded"
            value={formatCount(stats.not_recorded)}
            detail={stats.not_recorded === 1 ? 'event' : 'events'}
            note="Not an absence, but included in the rate"
          />
        </StatGrid>
        <Text variant="caption" color="textMuted">
          {RATE_NOTE} {NOT_RECORDED_NOTE}
        </Text>
      </View>

      <StatGrid>
        <StatCard
          label="Attended"
          value={formatCount(stats.attended)}
          detail={stats.attended === 1 ? 'event' : 'events'}
        />
        <StatCard
          label="Confirmed RSVPs"
          value={formatCount(stats.confirmed_rsvps)}
          detail={`${subject ? 'Said' : 'You said'} going`}
        />
        <StatCard label="Missed" value={formatCount(stats.missed)} help={MISSED_HELP} />
        {stats.walk_ins > 0 ? (
          <StatCard label="Walk-ins" value={formatCount(stats.walk_ins)} help={WALK_INS_HELP} />
        ) : null}
      </StatGrid>

      <StatGrid>
        <StatCard
          label="RSVP reliability"
          value={formatPercent(stats.rsvp_reliability)}
          detail={
            stats.rsvp_going_recorded > 0
              ? ofCount(stats.rsvp_going_present, stats.rsvp_going_recorded, 'recorded going RSVPs')
              : 'No recorded going RSVPs yet'
          }
          note={reliabilitySample}
          help={RELIABILITY_HELP}
          style={{ flexBasis: '100%' }}
        />
      </StatGrid>

      <View style={{ gap: spacing.sm }}>
        <Text variant="heading">Monthly participation</Text>
        <Text variant="caption" color="textMuted">
          Attendance rate per month. A dash means no finalized events that month.
        </Text>
        <Card>
          {months.length === 0 ? (
            <Text color="textMuted">No months to show yet.</Text>
          ) : (
            <BarChart
              values={rates}
              axisLabels={axisLabels(
                months.map((month) => month.period),
                'month',
              )}
              valueLabels={rates.map((rate) => formatPercent(rate))}
              captions={months.map((month) =>
                month.eligible > 0 ? `${month.attended}/${month.eligible}` : null,
              )}
              scale={rateScale()}
              formatTick={(tick) => `${tick}%`}
              accessibilitySummary={monthlySummary(months)}
            />
          )}
        </Card>
      </View>
    </View>
  );
}

