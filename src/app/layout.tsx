import type { Metadata, Viewport } from "next";
import { Manrope, Geist_Mono } from "next/font/google";
import "./globals.css";

/*
 * The studio's own face rather than Apple's system font, so it follows the
 * HIG's typographic hierarchy without reading as an Apple app - and looks the
 * same on every executive's machine.
 */
const manrope = Manrope({
  variable: "--font-manrope",
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
    { media: "(prefers-color-scheme: light)", color: "#f3f5f8" },
    { media: "(prefers-color-scheme: dark)", color: "#060a10" },
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
    <html lang="en" className={`${manrope.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
