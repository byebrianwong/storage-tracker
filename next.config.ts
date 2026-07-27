import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  /*
    pdfjs-dist reaches its canvas backend through
    createRequire(import.meta.url)('@napi-rs/canvas'), which is opaque to the
    bundler. If pdfjs gets bundled into .next/server/chunks/, that require
    resolves relative to the chunk, and under pnpm's strict node_modules layout
    @napi-rs/canvas is nested inside pdfjs-dist's own directory, so it is not
    found. The build stays green and every PDF upload fails at runtime.

    Marking it external keeps it resolvable AND gets it traced into the
    deployment bundle, which the dynamic import alone does not guarantee.
  */
  serverExternalPackages: ['pdfjs-dist'],
}

export default nextConfig
