/**
 * S1 — Root Layout
 *
 * Minimal global styles for the Mission Control app.
 * Dark ops-centre theme. No external design libraries.
 */

import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mission Control",
  description: "Operating system for the Reliable Tradies AI organisation",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
