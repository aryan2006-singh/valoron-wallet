import type { Metadata } from "next";
import { AuthPage } from "@/components/auth";

export const metadata: Metadata = { title: "Log in · Valoron" };

export default function LoginPage() {
  return <AuthPage mode="login" />;
}
