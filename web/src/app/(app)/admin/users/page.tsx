import type { Metadata } from "next";
import { requireRole } from "@/lib/auth-server";
import { apiFetchServer } from "@/lib/api/server";
import { usersListResponse } from "@/lib/api/users";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const metadata: Metadata = { title: "Users" };

/**
 * The worked example of a SERVER-side, role-gated, paginated read.
 *
 * Three things are worth copying out of this file:
 *
 *   1. `requireRole("admin")` runs before the fetch. The API would refuse the
 *      request anyway (`app.requireRole("admin")` on the route), but failing
 *      here turns a screenful of errors into a redirect.
 *
 *   2. The response schema is the SAME object the browser-side caller uses —
 *      imported from `lib/api/users.ts`. One definition per endpoint, whichever
 *      side calls it.
 *
 *   3. `searchParams` is awaited and coerced. Query strings are strings; the
 *      API coerces them too, and sending `page=abc` should be a 400 from the
 *      API rather than `NaN` rendered into a link.
 */
export default async function AdminUsersPage({
  searchParams,
}: PageProps<"/admin/users">) {
  await requireRole("admin");

  const params = await searchParams;
  const page = Number(typeof params.page === "string" ? params.page : "1");

  const { data: users, meta } = await apiFetchServer("/api/v1/users", usersListResponse, {
    query: { page: Number.isFinite(page) && page > 0 ? page : 1, limit: 20 },
  });

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
        <p className="text-sm text-muted-foreground">
          {meta.total} total · page {meta.page} of {Math.max(meta.totalPages, 1)}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">All accounts</CardTitle>
          <CardDescription>
            Visible to administrators only — these rows carry email addresses.
          </CardDescription>
        </CardHeader>

        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">Name</th>
                  <th className="py-2 pr-4 font-medium">Email</th>
                  <th className="py-2 font-medium">Role</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id} className="border-b last:border-0">
                    <td className="py-2 pr-4">{user.name}</td>
                    <td className="py-2 pr-4 text-muted-foreground">{user.email}</td>
                    <td className="py-2">
                      <Badge variant={user.role === "admin" ? "default" : "secondary"}>
                        {user.role}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
