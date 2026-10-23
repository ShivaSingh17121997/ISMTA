import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AppShell } from "./components/AppShell";
import { AuthProvider } from "./providers/AuthProvider";
import { LiveProvider } from "./providers/LiveProvider";
import { ShortcutsProvider } from "./providers/ShortcutsProvider";
import { SystemProvider } from "./providers/SystemProvider";
import { ThemeProvider } from "./providers/ThemeProvider";
import { ToastProvider } from "./providers/ToastProvider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ISMTA — Indian Stock Market Trading Automation",
  description: "Automated multi-strategy trading dashboard (paper-trading MVP)",
};

/**
 * Runs while the HTML is still parsing, before first paint, so a dark-theme
 * user never sees a white flash. Same rule as ThemeProvider: an explicit
 * choice in localStorage wins, otherwise the OS preference.
 */
const THEME_BOOT = `(function(){try{var t=localStorage.getItem('ismta_theme');var d=t==='dark'||(t!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);var r=document.documentElement;r.classList.toggle('dark',d);r.style.colorScheme=d?'dark':'light';}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body className="min-h-full">
        <ThemeProvider>
          <AuthProvider>
            <ToastProvider>
              <SystemProvider>
                <LiveProvider>
                  <ShortcutsProvider>
                    <AppShell>{children}</AppShell>
                  </ShortcutsProvider>
                </LiveProvider>
              </SystemProvider>
            </ToastProvider>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
