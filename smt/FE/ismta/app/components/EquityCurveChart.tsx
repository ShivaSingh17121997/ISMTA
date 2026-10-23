'use client';

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { num, time } from '../lib/format';

export function EquityCurveChart({ data }: { data: { t: number; equity: number }[] }) {
  const chartData = data.map((d) => ({ ...d, label: time(d.t) }));
  return (
    <ResponsiveContainer width="100%" height={280}>
      <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#2563eb" stopOpacity={0.4} />
            <stop offset="95%" stopColor="#2563eb" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#27272a" opacity={0.3} />
        <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#71717a' }} minTickGap={40} />
        <YAxis
          tick={{ fontSize: 11, fill: '#71717a' }}
          domain={['auto', 'auto']}
          tickFormatter={(v) => num(v, 0)}
          width={70}
        />
        <Tooltip
          contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8, fontSize: 12 }}
          formatter={(v) => [num(Number(v)), 'Equity']}
        />
        <Area type="monotone" dataKey="equity" stroke="#2563eb" fill="url(#eq)" strokeWidth={2} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
