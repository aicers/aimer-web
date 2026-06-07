import { expect, type Page } from "@playwright/test";

// Real Keycloak login for Tier-2 E2E (#452).
//
// This deliberately drives the actual Keycloak login UI + OIDC
// redirect/callback instead of the JWT cookie-injection shortcut used by the
// regular fixtures (e2e/fixtures/auth.ts). The acceptance step of the
// invitation flow MUST go through real OIDC for the test to mean anything.
//
// The `aimer-web` general client has no MFA browser-flow override (only
// `aimer-web-admin` does), so its login is a plain username + password form.

const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? "http://localhost:8080";
const APP_ORIGIN = process.env.BASE_URL ?? "http://localhost:3000";

export interface KeycloakCredentials {
  username: string;
  password: string;
}

/**
 * Submit the Keycloak login form. Assumes the page has already been
 * redirected to Keycloak (e.g. by navigating the invite-entry link, which
 * 307s through the app sign-in endpoint to the IdP).
 *
 * Resolves once Keycloak has redirected the browser back to the app origin
 * (the OIDC callback). It does NOT assert the final app destination — callers
 * assert success (`/`) or deny (`/deny?...`) themselves.
 */
export async function loginViaKeycloak(
  page: Page,
  creds: KeycloakCredentials,
): Promise<void> {
  // Wait until we are actually on the Keycloak login page.
  await page.waitForURL(`${KEYCLOAK_URL}/**`, { timeout: 30_000 });

  await expect(page.locator("#username")).toBeVisible({ timeout: 15_000 });
  await page.locator("#username").fill(creds.username);
  await page.locator("#password").fill(creds.password);
  await page.locator("#kc-login").click();

  // Wait for the browser to land back on the app (the OIDC callback then
  // redirects to `/` on success or `/deny` on failure — both are app-origin).
  await page.waitForURL(`${APP_ORIGIN}/**`, { timeout: 30_000 });
}
