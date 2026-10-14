import { PageLoader } from "@/components/nua/page-loader";

/**
 * Shown the moment a route starts rendering on the server and replaced as the
 * real page streams in. Every page here is dynamic (the header reads the
 * session), so without it a navigation has nothing to show for a second.
 */
export default function Loading() {
  return <PageLoader />;
}
