import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Log in or sign up",
  description: "Log in to ChiefAI or create an account to start your AI-run growth dashboard.",
  alternates: { canonical: "/signup" },
};

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return children;
}
