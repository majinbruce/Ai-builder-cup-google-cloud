import type { Metadata } from "next";
import { requireSession } from "@/lib/auth-server";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ProfileForm } from "@/components/auth/profile-form";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const { user } = await requireSession();

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Manage your account.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Profile</CardTitle>
          <CardDescription>
            {/* Email is owned by Better Auth's own flows and is deliberately
                not editable through /api/v1 — see the API's rule 4. */}
            Your email address ({user.email}) is managed by the sign-in provider and
            cannot be changed here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ProfileForm name={user.name} />
        </CardContent>
      </Card>
    </div>
  );
}
