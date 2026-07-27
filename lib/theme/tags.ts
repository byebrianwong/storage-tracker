/**
 * Category colours. Direction C uses these as the primary wayfinding channel
 * ("camping green, second shelf"), directions A and B ignore them because the
 * fill comes from a theme token instead. Section 9.5: the renderer reads
 * --tag-color, it never decides a colour itself.
 */
export const TAG_COLORS: Record<string, string> = {
  Winter: '#8EC5F5', Beach: '#F5D77E', Dog: '#F58C7E', Coats: '#7EE0B8',
  Daily: '#C9A7F5', Cleaning: '#7EE0B8', Shoes: '#F5D77E', Camping: '#7EE0B8',
  Bedding: '#8EC5F5', Luggage: '#C9A7F5', Docs: '#F5D77E', Tools: '#F58C7E',
  Medicine: '#8EC5F5', Paper: '#F5D77E', Baking: '#F58C7E', Bulk: '#7EE0B8',
  Cables: '#C9A7F5', Games: '#F58C7E', Photos: '#8EC5F5', Garden: '#7EE0B8',
  Sports: '#F5D77E', Spare: '#C9A7F5',
}

const FALLBACK = '#4A4066'

/** Case insensitive lookup, so a tag typed as "camping" still resolves. */
export function tagColor(tag: string | null | undefined): string {
  if (!tag) return FALLBACK
  const direct = TAG_COLORS[tag]
  if (direct) return direct
  const key = Object.keys(TAG_COLORS).find((k) => k.toLowerCase() === tag.toLowerCase())
  return key ? TAG_COLORS[key] : FALLBACK
}

export const TAG_NAMES = Object.keys(TAG_COLORS)

export type SkinId = 'a' | 'b' | 'c'

export const SKINS: { id: SkinId; name: string; blurb: string }[] = [
  { id: 'a', name: 'Plan and elevation', blurb: 'Drafting vernacular, hatch fill, height dimensions.' },
  { id: 'b', name: 'Card catalog', blurb: 'Kraft board, typed label plates, brass pulls.' },
  { id: 'c', name: 'Bins', blurb: 'Colour coded categories on a dark shell.' },
]
