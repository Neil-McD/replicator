import type { Metadata } from 'next'
import './globals.css'
import { Space_Grotesk, IBM_Plex_Mono } from 'next/font/google'
import { WorkspaceProvider } from '@/components/workspace/WorkspaceProvider'
import SWRegister from '@/components/SWRegister'

const spaceGrotesk = Space_Grotesk({ subsets: ['latin'], variable: '--font-space-grotesk' })
const plexMono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400','600'], variable: '--font-plex-mono' })

export const metadata: Metadata = {
  title: 'Replicator',
  description: 'Prompt → Print, minimal replicator',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${spaceGrotesk.variable} ${plexMono.variable}`}>
      <body>
        <SWRegister />
        <WorkspaceProvider>{children}</WorkspaceProvider>
      </body>
    </html>
  )
}
