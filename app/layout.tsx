import type { Metadata } from 'next';
import { Inter_Tight } from 'next/font/google';
import './globals.css';
import { Providers } from '@/app/providers';

const interTight = Inter_Tight({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans',
});
export const metadata: Metadata = {
  title: 'Bridge Hub UI',
  description: '',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${interTight.variable} antialiased`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
