'use client';

import { time } from '../lib/format';
import { useLive } from '../providers/LiveProvider';

const dot: Record<string, string> = {
  green: 'bg-emerald-500',
  red: 'bg-rose-500',
  blue: 'bg-blue-500',
  neutral: 'bg-zinc-400',
};

export function LiveFeed() {
  const { events } = useLive();
  if (!events.length) {
    return <p className="py-6 text-center text-sm text-zinc-400">Waiting for live events…</p>;
  }
  return (
    <ul className="scroll-thin max-h-80 space-y-2 overflow-y-auto">
      {events.map((e) => (
        <li key={e.id} className="flex items-start gap-2 text-sm">
          <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot[e.tone]}`} />
          <span className="flex-1 text-zinc-700 dark:text-zinc-300">{e.text}</span>
          <span className="shrink-0 text-xs text-zinc-400">{time(e.ts)}</span>
        </li>
      ))}
    </ul>
  );
}
