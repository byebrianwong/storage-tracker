import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { AppBar } from '@/components/chrome/AppBar'
import { SkinSwitcher } from '@/components/chrome/SkinSwitcher'
import { currentHousehold } from '@/lib/db/server'
import { syncHealth } from '@/lib/queries'
import type { SkinId } from '@/lib/theme/tags'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const householdId = await currentHousehold()
  if (!householdId) redirect('/login')

  const [sync, cookieStore] = await Promise.all([syncHealth(householdId), cookies()])
  const raw = cookieStore.get('skin')?.value as SkinId | undefined
  const skin: SkinId = raw === 'b' || raw === 'c' ? raw : 'a'

  return (
    <div className="flex min-h-dvh flex-col">
      <AppBar sync={sync} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-4">{children}</main>
      <footer
        className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-3 px-4 py-4"
        style={{ borderTop: 'var(--rule)' }}
      >
        <SkinSwitcher current={skin} />
      </footer>
    </div>
  )
}
