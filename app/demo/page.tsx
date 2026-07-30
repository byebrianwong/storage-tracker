import type { Metadata } from 'next'
import { DemoApp } from './DemoApp'

export const metadata: Metadata = {
  title: 'Demo · Where is it',
  description: 'Try the home storage inventory. No account needed, nothing is saved.',
}

/** Public. No session, no database — see lib/demo/sample.ts. */
export default function DemoPage() {
  return <DemoApp />
}
