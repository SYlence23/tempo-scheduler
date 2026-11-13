export function clockMinutes(value) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return NaN;
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

export function clockParts(hours, startTime = '09:00') {
  const start = clockMinutes(startTime);
  if (!Number.isFinite(hours) || !Number.isFinite(start)) return { time: '', day: 1 };
  const absolute = Math.round(start + hours * 60);
  const day = Math.floor(absolute / 1440) + 1;
  const minutes = ((absolute % 1440) + 1440) % 1440;
  return { time: `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`, day };
}

export function deadlineHours(time, day, startTime, previous) {
  const minutes = clockMinutes(time);
  const start = clockMinutes(startTime);
  if (!Number.isFinite(minutes) || !Number.isFinite(start) || !Number.isInteger(day) || day < 1 || day > 4168) return NaN;
  const existing = clockParts(previous, startTime);
  if (Number.isFinite(previous) && existing.time === time && existing.day === day) return previous;
  return Math.round(((day - 1) * 1440 + minutes - start) / 60 * 1000) / 1000;
}

export function clockLabel(hours, startTime) {
  const { time, day } = clockParts(hours, startTime);
  return time ? `${time}${day > 1 ? ` · день ${day}` : ''}` : '—';
}
