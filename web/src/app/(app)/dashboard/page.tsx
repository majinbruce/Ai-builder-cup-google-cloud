import { redirect } from "next/navigation";

/**
 * The boilerplate's post-login landing, kept as a route so an old bookmark or
 * a stale `?next=` still lands somewhere. The product's home behind the login
 * is the upload page, which is where sign-in sends everyone anyway.
 */
export default function DashboardPage() {
  redirect("/localize");
}
