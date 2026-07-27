import type { Metadata, Viewport } from 'next'
import { cookies } from 'next/headers'
import { IBM_Plex_Sans, IBM_Plex_Mono, Courier_Prime, Bitter, Outfit } from 'next/font/google'
import type { SkinId } from '@/lib/theme/tags'
import './globals.css'

// Self hosted rather than a stylesheet link: no render blocking request to
// fonts.googleapis.com, and no third party origin to allow in a CSP.
const plexSans = IBM_Plex_Sans({
  variable: '--font-plex-sans', subsets: ['latin'], weight: ['400', '500', '600'], display: 'swap',
})
const plexMono = IBM_Plex_Mono({
  variable: '--font-plex-mono', subsets: ['latin'], weight: ['400', '500'], display: 'swap',
})
const courierPrime = Courier_Prime({
  variable: '--font-courier-prime', subsets: ['latin'], weight: ['400', '700'], display: 'swap',
})
const bitter = Bitter({
  variable: '--font-bitter', subsets: ['latin'], weight: ['400', '600'], display: 'swap',
})
const outfit = Outfit({
  variable: '--font-outfit', subsets: ['latin'], weight: ['400', '500', '700'], display: 'swap',
})

export const metadata: Metadata = {
  title: 'Where is it',
  description: 'Home storage inventory',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

const SKIN_COOKIE = 'skin'
const VALID: SkinId[] = ['a', 'b', 'c']

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Section 9.5: one attribute on the root element drives the whole visual
  // direction. Read server side so there is no flash of the wrong skin.
  const raw = (await cookies()).get(SKIN_COOKIE)?.value as SkinId | undefined
  const skin: SkinId = raw && VALID.includes(raw) ? raw : 'a'

  const fonts = [plexSans, plexMono, courierPrime, bitter, outfit]
    .map((f) => f.variable).join(' ')

  return (
    <html lang="en" data-skin={skin} className={`${fonts} h-full antialiased`}>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  )
}
