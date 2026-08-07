import { isBusinessDate } from '@fitness/contracts';

export function businessDateAt(isoInstant: string, timeZone: string): string {
  const instant = new Date(isoInstant);
  if (Number.isNaN(instant.getTime())) {
    throw new RangeError('Invalid ISO instant');
  }
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const values = new Map(
    formatter.formatToParts(instant).map((part) => [part.type, part.value])
  );
  const year = values.get('year');
  const month = values.get('month');
  const day = values.get('day');
  if (year === undefined || month === undefined || day === undefined) {
    throw new RangeError('Unable to resolve business date');
  }
  const businessDate = `${year}-${month}-${day}`;
  if (!isBusinessDate(businessDate)) {
    throw new RangeError('Resolved business date is invalid');
  }
  return businessDate;
}
