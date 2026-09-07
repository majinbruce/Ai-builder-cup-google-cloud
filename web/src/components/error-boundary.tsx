"use client";

import { Component, type ReactNode } from "react";

/**
 * A component-level error boundary, for the case Next's route-level
 * `error.tsx` is too coarse.
 *
 * React still has no hook for this — catching a render error requires a class
 * component with `getDerivedStateFromError`, and that is the only reason this
 * file contains one.
 *
 * Use it to make a NON-ESSENTIAL part of the page degrade instead of taking the
 * route down with it. The header's auth slot is the shipped example: if the API
 * is unreachable, the header should lose its avatar menu, not turn the landing
 * page into a 500.
 *
 * Do not use it to swallow errors from something the page is actually for —
 * that hides bugs. If the content is the point, let it reach `error.tsx`.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
