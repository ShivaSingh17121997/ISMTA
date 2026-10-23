/**
 * The tricolour logo, drawn rather than the 🇮🇳 emoji: Windows ships no flag
 * glyphs, so the emoji showed as the letters "IN" there.
 */
export default function BrandMark({ size = 28 }: { size?: number }) {
  const h = Math.round((size * 2) / 3);
  return (
    <svg width={size} height={h} viewBox="0 0 30 20" aria-hidden="true" className="shrink-0 rounded-sm shadow-sm ring-1 ring-black/10">
      <rect width="30" height="20" fill="#ffffff" />
      <rect width="30" height="6.67" fill="#FF9933" />
      <rect y="13.33" width="30" height="6.67" fill="#138808" />
      <circle cx="15" cy="10" r="2.6" fill="none" stroke="#000080" strokeWidth="0.6" />
      <circle cx="15" cy="10" r="0.5" fill="#000080" />
    </svg>
  );
}
