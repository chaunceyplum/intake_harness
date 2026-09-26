import type { Metadata, Viewport } from "next";
import { Inter, Geist_Mono } from "next/font/google";
import "./globals.css";

/*
 * Inter is the fallback, not the face: the stack in globals.css puts Apple's
 * own system font first (SF Pro on a Mac or iPhone), per the Human Interface
 * Guidelines' typography, and Inter - the closest open match - stands in on
 * Windows and Android.
 */
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Audience Studio",
  description: "Describe an audience in plain English and have it built in Adobe Experience Platform.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f5f7" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

/*
 * No sidebar here: the home page is the executive-facing Audience Studio and
 * owns the whole screen. The operator pages (Runs, Evals, Agents, Settings)
 * get the sidebar from (workbench)/layout.tsx instead.
 *
 * LayoutProps is a global Next generates only with typedRoutes enabled, which
 * this project does not have - so the name did not exist and the build could
 * not typecheck. Spelled out instead, which is what the generated type is.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
