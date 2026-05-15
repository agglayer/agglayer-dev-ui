import type { Metadata } from 'next';

import { Header } from '@/app/components/header/header';

import './globals.css';
import { Providers } from '@/app/providers';
import { Inter_Tight } from 'next/font/google';

const interTight = Inter_Tight({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans'
});

export const metadata: Metadata = {
  title: 'Agglayer Dev UI',
  description: ''
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full">
      <body className={`${interTight.variable} antialiased`}>
        <Providers>
          <div className="relative min-h-screen w-full bg-background">
            <header className="flex w-full justify-center">
              <Header />
            </header>
            <main className="mx-auto w-full pb-10">{children}</main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
