import type { Metadata } from "next";
import { requireSession } from "@/lib/auth-server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const metadata: Metadata = { title: "Dashboard" };

/**
 * The first screen behind the login, and a working example of reading the
 * session on the server.
 *
 * `requireSession()` here as well as in the layout is not redundant: it is
 * memoised per render (React `cache`), so it costs one API call for the whole
 * tree, and it hands this component a non-nullable session without a cast.
 *
 * Replace the body. Keep the pattern.
 */
export default async function DashboardPage() {
  const { user } = await requireSession();

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Welcome, {user.name}</h1>
        <p className="text-sm text-muted-foreground">
          This page is only reachable with a valid session.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your session</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          <Row label="Email">
            <span className="flex items-center gap-2">
              {user.email}
              {user.emailVerified ? null : <Badge variant="secondary">unverified</Badge>}
            </span>
          </Row>
          <Row label="Role">
            <Badge variant={user.role === "admin" ? "default" : "secondary"}>
              {user.role}
            </Badge>
          </Row>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
