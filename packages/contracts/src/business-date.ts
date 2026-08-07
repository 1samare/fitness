import { z } from 'zod';

const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isBusinessDate(value: string): boolean {
  const match = datePattern.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() === month - 1
    && candidate.getUTCDate() === day;
}

export function addBusinessDays(value: string, days: number): string {
  if (!isBusinessDate(value) || !Number.isInteger(days)) {
    throw new Error('Invalid business date arithmetic input');
  }
  const candidate = new Date(`${value}T00:00:00.000Z`);
  candidate.setUTCDate(candidate.getUTCDate() + days);
  return candidate.toISOString().slice(0, 10);
}

export const businessDateSchema = z.string().refine(isBusinessDate, {
  message: 'Expected a real calendar date in YYYY-MM-DD format'
});
