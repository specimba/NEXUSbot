import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
// v38 — ONE global sonner <Toaster> lives here. Cards used to mount their own
// (up to 5 simultaneously on the Connectors tab) — duplicate subscriptions and
// render work per toast on the long-lived panel tab.
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import { Providers } from "./providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "NEXUS OS — Control Panel",
  description:
    "Owner-only control panel for the NEXUS_BOT pipeline: L0 event stream, agent capabilities, gated evaluation.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // suppressHydrationWarning on both <html> and <body>: browser extensions
    // (e.g. Grammarly) inject attributes before React hydrates. This is the
    // sanctioned Next.js fix — it does not mask app-level bugs.
    <html lang="en" suppressHydrationWarning>
      <body
        suppressHydrationWarning
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <Providers>{children}</Providers>
        <Toaster />
        <SonnerToaster richColors position="bottom-right" />
      </body>
    </html>
  );
}
