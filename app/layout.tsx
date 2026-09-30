import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Moments Timeline",
  description: "A shared chronological photo journal.",
  icons: { icon: "/favicon.svg" },
};
export default function RootLayout({children}:{children:React.ReactNode}){
  return <html lang="en"><body>{children}</body></html>;
}
