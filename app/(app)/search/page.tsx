import Link from 'next/link'
import { supabaseServer } from '@/lib/db/server'

type Row = {
  item_id: string
  name: string
  quantity: number
  category: string | null
  zone_id: string | null
  zone_name: string | null
  shelf_name: string | null
  container_id: string | null
  container_label: string | null
}

export default async function SearchPage({
  searchParams,
}: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams
  const term = (q ?? '').trim()

  let rows: Row[] = []
  if (term) {
    const supabase = await supabaseServer()
    const { data } = await supabase.rpc('search_items', { q: term, lim: 50 })
    rows = (data ?? []) as Row[]
  }

  return (
    <>
      <div className="mb-3">
        <p className="eyebrow">Search</p>
        <h1 className="zonename">
          {term ? `${rows.length} ${rows.length === 1 ? 'result' : 'results'} for “${term}”` : 'Search'}
        </h1>
      </div>

      {!term && <p className="muted text-sm">Type in the box above, or press Cmd K from anywhere.</p>}

      {term && rows.length === 0 && (
        <p className="muted text-sm">No match. Try a category like camping or docs.</p>
      )}

      <ul className="list-none p-0">
        {rows.map((r) => (
          <li key={r.item_id} className="rule py-0 last:border-b-0">
            {r.zone_id && r.container_id ? (
              <Link
                href={`/zone/${r.zone_id}?container=${r.container_id}`}
                className="block py-3 no-underline"
                style={{ color: 'var(--ink)' }}
              >
                <span className="text-sm">{r.name}</span>
                <span className="mono muted mt-0.5 block text-[11px]">
                  {r.zone_name} / {r.shelf_name} / {r.container_label}
                </span>
              </Link>
            ) : (
              <div className="py-3">
                <span className="text-sm">{r.name}</span>
                <span className="mono muted mt-0.5 block text-[11px]">Unsorted</span>
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  )
}
