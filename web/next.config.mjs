/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Prevent CI/Preview builds from failing on lint or TS issues.
  // We still run these locally and in PR checks, but Vercel previews
  // should prioritize deployability for smoke tests.
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
  experimental: {
    // App Router is default in Next 14; no special flags needed
  },
}

export default nextConfig;
