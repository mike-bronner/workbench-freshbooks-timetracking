const formatters = new Map();

const formatter = (tz) => {
  if (!formatters.has(tz)) {
    formatters.set(tz, new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }));
  }
  return formatters.get(tz);
};

const parts = (ms, tz) => Object.fromEntries(
  formatter(tz).formatToParts(new Date(ms)).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]),
);

const offsetMs = (ms, tz) => {
  const p = parts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
};

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export const isDate = (value) => {
  const m = DATE.exec(value ?? '');
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.toISOString().slice(0, 10) === value;
};

export const localDate = (ms, tz) => {
  const p = parts(ms, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
};

export const addDays = (date, days) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

export const zonedMidnight = (date, tz) => {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - offsetMs(guess, tz);
  return guess - offsetMs(first, tz);
};

export function splitAtMidnight(start, end, tz) {
  const pieces = [];
  let from = start;
  let day = localDate(from, tz);
  while (day !== localDate(end, tz)) {
    const boundary = zonedMidnight(addDays(day, 1), tz);
    if (boundary <= from || boundary > end) break;
    pieces.push({ start: from, end: boundary, date: day });
    from = boundary;
    day = localDate(from, tz);
  }
  pieces.push({ start: from, end, date: day });
  return pieces;
}

export function rangeChoices(today, lastBilled) {
  const monthStart = `${today.slice(0, 7)}-01`;
  const lastMonthEnd = addDays(monthStart, -1);
  const choice = (label, from, to) => ({ label, description: `${from} to ${to}`, from, to });
  return {
    today,
    last_billed: lastBilled,
    choices: [
      ...(lastBilled ? [choice('Since last billed', lastBilled < today ? lastBilled : today, today)] : []),
      choice('This month so far', monthStart, today),
      choice('Last month', `${lastMonthEnd.slice(0, 7)}-01`, lastMonthEnd),
    ],
  };
}
