import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Outstanding Invoices Dashboard",
  description: "Open & past-due invoices from Stripe — India & US",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
