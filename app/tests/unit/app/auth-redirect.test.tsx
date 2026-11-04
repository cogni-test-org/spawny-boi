// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/auth-redirect`
 * Purpose: Keep completed SIWE sign-in on the shared loading surface until navigation.
 * Scope: Session transitions and hard navigation, with presentational shell stubs.
 * Invariants: No shell before authentication; one wordless loader after authentication.
 * Side-effects: none (mocked navigation)
 * @vitest-environment happy-dom
 * @internal
 */

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthRedirect } from "@/app/(public)/AuthRedirect";

const session = vi.hoisted(() => ({ status: "unauthenticated" }));
vi.mock("next-auth/react", () => ({ useSession: () => session }));
vi.mock("@/features/layout/components/AppShell", () => ({
  AppShell: ({ children }: { children: ReactNode }) => (
    <div data-testid="shared-app-shell">{children}</div>
  ),
}));

describe("Completed sign-in handoff", () => {
  beforeEach(() => vi.spyOn(window.location, "replace").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it.each(["loading", "unauthenticated"])("waits while session is %s", (status) => {
    session.status = status;
    render(<AuthRedirect />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByTestId("shared-app-shell")).toBeNull();
    expect(window.location.replace).not.toHaveBeenCalled();
  });

  it("commits the shared wordless shell before requesting the authenticated page", () => {
    session.status = "authenticated";
    const shellAtNavigation: boolean[] = [];
    vi.mocked(window.location.replace).mockImplementation(() => {
      shellAtNavigation.push(
        document.querySelector('[data-testid="shared-app-shell"]') !== null
      );
    });
    render(<AuthRedirect />);
    expect(screen.getByTestId("shared-app-shell")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading" }).textContent).toBe("");
    expect(shellAtNavigation[0]).toBe(true);
    expect(window.location.replace).toHaveBeenCalledExactlyOnceWith("/chat");
    expect(screen.queryByText(/redirecting/i)).toBeNull();
  });
});
