import type { Metadata } from "next";
import type React from "react";
import { Chakra_Petch, JetBrains_Mono, IBM_Plex_Sans } from "next/font/google";
import { QueryProvider } from "@/components/query-provider";
import { ConsoleShell } from "@/components/console/console-shell";
import { APP_TITLE, APP_SUBTITLE, LOGO_SRC } from "@/lib/constants";
import "./globals.css";

/**
 * next/font downloads and self-hosts these at BUILD time, so there is no
 * runtime CDN dependency. If build-time egress is ever hardened in the target
 * account, swap these three for next/font/local and vendor the .woff2 files
 * into app/fonts - the rest of the app reads the CSS variables only.
 *
 * Chakra Petch: square-cornered technical display face. Used >=14px, uppercase,
 *   tracked, for labels and headings only - it is tiring as body text.
 * JetBrains Mono: every numeral, ID, timestamp and duration. True tabular
 *   figures and unambiguous 0/O and 1/l/I.
 * IBM Plex Sans: dense prose and table text. Notably not Inter.
 */
const chakra = Chakra_Petch({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-chakra",
  display: "swap",
});
const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-jetbrains",
  display: "swap",
});
const plex = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex",
  display: "swap",
});

export const metadata: Metadata = {
  title: `${APP_TITLE} — ${APP_SUBTITLE}`,
  description: "Live operational monitoring for Cortex Agents in this Snowflake account.",
  icons: { icon: LOGO_SRC },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${chakra.variable} ${jetbrains.variable} ${plex.variable} font-sans antialiased`}
      >
        <QueryProvider>
          <ConsoleShell>{children}</ConsoleShell>
        </QueryProvider>
      </body>
    </html>
  );
}
