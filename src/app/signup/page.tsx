import type { Metadata } from "next";
import { AuthPage } from "@/components/auth";

export const metadata: Metadata = { title: "Create account · Valoron" };

export default function SignupPage() {
  return <AuthPage mode="signup" />;
}
