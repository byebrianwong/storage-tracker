import { notFound } from 'next/navigation'
import { PreviewHarness } from './PreviewHarness'

/**
 * Development only. Renders both canvases against fixed sample data in every
 * visual direction, so the drawing code can be checked without a Supabase
 * project, a plan upload, or a single row in the database.
 *
 * Returns 404 in production.
 */
export default function PreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound()
  return <PreviewHarness />
}
