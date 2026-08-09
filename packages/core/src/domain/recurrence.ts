import { addDays, addMonths, clampDay, compareDates, formatDate, parseDateParts } from "./dates";
import type { Cadence } from "./types";

export function expandCadence(
  cadence: Cadence,
  firstOccurrenceDate: string,
  horizonStartDate: string,
  horizonEndDate: string,
): string[] {
  if (compareDates(firstOccurrenceDate, horizonEndDate) > 0) return [];

  if (cadence.kind === "once") {
    return compareDates(firstOccurrenceDate, horizonStartDate) >= 0 ? [firstOccurrenceDate] : [];
  }

  const dates: string[] = [];
  let current = firstOccurrenceDate;

  while (compareDates(current, horizonStartDate) < 0) {
    current = nextOccurrence(cadence, current);
  }

  while (compareDates(current, horizonEndDate) <= 0) {
    dates.push(current);
    current = nextOccurrence(cadence, current);
  }

  return dates;
}

function nextOccurrence(cadence: Exclude<Cadence, { kind: "once" }>, currentDate: string): string {
  switch (cadence.kind) {
    case "weekly":
      return addDays(currentDate, cadence.intervalWeeks * 7);
    case "biweekly":
      return addDays(currentDate, 14);
    case "monthly":
      return addMonths(currentDate, 1, cadence.dayOfMonth);
    case "quarterly":
      return addMonths(currentDate, 3, cadence.dayOfMonth);
    case "annual": {
      const { year } = parseDateParts(currentDate);
      const day = clampDay(year + 1, cadence.month, cadence.dayOfMonth);
      return formatDate(year + 1, cadence.month, day);
    }
    case "semimonthly":
      return nextSemimonthlyDate(currentDate, cadence.daysOfMonth);
  }
}

function nextSemimonthlyDate(currentDate: string, daysOfMonth: [number, number]): string {
  const sortedDays = [...daysOfMonth].sort((left, right) => left - right);
  const { year, month, day } = parseDateParts(currentDate);

  for (const dayOfMonth of sortedDays) {
    const candidateDay = clampDay(year, month, dayOfMonth);
    if (candidateDay > day) {
      return formatDate(year, month, candidateDay);
    }
  }

  const nextMonthDate = addMonths(formatDate(year, month, 1), 1, 1);
  const nextParts = parseDateParts(nextMonthDate);
  const firstDay = sortedDays[0];
  if (firstDay === undefined) {
    throw new Error("Semimonthly cadence requires at least one day of month.");
  }
  const candidateDay = clampDay(nextParts.year, nextParts.month, firstDay);
  return formatDate(nextParts.year, nextParts.month, candidateDay);
}
