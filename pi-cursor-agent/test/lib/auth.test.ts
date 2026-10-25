import assert from "node:assert/strict";
import test from "node:test";
import type Auth from "../../src/api/auth.js";
import AuthManager from "../../src/lib/auth.js";

class MockAuth {
  lastExchangeToken = "";
  lastOAuthRefreshToken = "";
  exchangeResult: { accessToken: string; refreshToken: string } | null = null;
  oauthResult: {
    accessToken: string;
    refreshToken?: string;
    shouldLogout: boolean;
  } | null = null;
  exchangeError: Error | null = null;
  oauthError: Error | null = null;

  async exchangeUserApiKey({ token }: { token: string }) {
    this.lastExchangeToken = token;
    if (this.exchangeError) {
      throw this.exchangeError;
    }
    if (!this.exchangeResult) {
      throw new Error("exchangeUserApiKey called without a mocked result");
    }
    return this.exchangeResult;
  }

  async refreshOAuthToken({ refreshToken }: { refreshToken: string }) {
    this.lastOAuthRefreshToken = refreshToken;
    if (this.oauthError) {
      throw this.oauthError;
    }
    if (!this.oauthResult) {
      throw new Error("refreshOAuthToken called without a mocked result");
    }
    return this.oauthResult;
  }

  async poll() {
    throw new Error("poll not mocked");
  }
}

// A JWT with a known exp (in seconds). Payload: { exp: 2000000000 }
const ACCESS_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjIwMDAwMDAwMDB9.c2ln";
const NEW_REFRESH_TOKEN = "refresh-returned-by-exchange";
const SESSION_JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjIwMDAwMDAwMDAsInR5cGUiOiJzZXNzaW9uIn0.c2ln";

test("refresh keeps the original crsr_ credential and returns new access", async () => {
  const mockAuth = new MockAuth();
  mockAuth.exchangeResult = {
    accessToken: ACCESS_TOKEN,
    refreshToken: NEW_REFRESH_TOKEN,
  };
  const manager = new AuthManager(
    mockAuth as unknown as Auth,
    "https://cursor.com",
  );

  const credentials = {
    access: "old-access",
    refresh: "crsr_test-api-key",
  };
  const result = await manager.refresh(credentials);

  assert.equal(mockAuth.lastExchangeToken, "crsr_test-api-key");
  assert.equal(mockAuth.lastOAuthRefreshToken, "");
  assert.equal(result.access, ACCESS_TOKEN);
  assert.equal(result.refresh, "crsr_test-api-key");
  assert.equal(result.expires, 2000000000 * 1000 - 5 * 60 * 1000);
});

test("refresh uses /oauth/token for session JWTs from browser login", async () => {
  const mockAuth = new MockAuth();
  mockAuth.oauthResult = {
    accessToken: ACCESS_TOKEN,
    shouldLogout: false,
  };
  const manager = new AuthManager(
    mockAuth as unknown as Auth,
    "https://cursor.com",
  );

  const credentials = {
    access: SESSION_JWT,
    refresh: SESSION_JWT,
  };
  const result = await manager.refresh(credentials);

  assert.equal(mockAuth.lastOAuthRefreshToken, SESSION_JWT);
  assert.equal(mockAuth.lastExchangeToken, "");
  assert.equal(result.access, ACCESS_TOKEN);
  // Prior refresh JWT is preserved when the response omits refresh_token.
  assert.equal(result.refresh, SESSION_JWT);
  assert.equal(result.expires, 2000000000 * 1000 - 5 * 60 * 1000);
});

test("refresh falls back to the access token when only access is present", async () => {
  const mockAuth = new MockAuth();
  mockAuth.oauthResult = {
    accessToken: ACCESS_TOKEN,
    shouldLogout: false,
  };
  const manager = new AuthManager(
    mockAuth as unknown as Auth,
    "https://cursor.com",
  );

  const credentials = { access: SESSION_JWT, refresh: "" };
  const result = await manager.refresh(credentials);

  assert.equal(mockAuth.lastOAuthRefreshToken, SESSION_JWT);
  assert.equal(result.access, ACCESS_TOKEN);
  assert.equal(result.refresh, SESSION_JWT);
});

test("refresh asks for re-login when Cursor sets shouldLogout", async () => {
  const mockAuth = new MockAuth();
  mockAuth.oauthResult = {
    accessToken: "",
    shouldLogout: true,
  };
  const manager = new AuthManager(
    mockAuth as unknown as Auth,
    "https://cursor.com",
  );

  await assert.rejects(
    manager.refresh({ access: SESSION_JWT, refresh: "" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Failed to refresh credentials/);
      assert.match(error.message, /run \/login cursor-agent/);
      return true;
    },
  );
});

test("refresh rethrows with a descriptive error when both credentials fail", async () => {
  const mockAuth = new MockAuth();
  mockAuth.exchangeError = new Error("Invalid User API Key");
  const manager = new AuthManager(
    mockAuth as unknown as Auth,
    "https://cursor.com",
  );

  await assert.rejects(
    manager.refresh({ access: "crsr_acc", refresh: "crsr_rej" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Failed to refresh credentials/);
      assert.match(error.message, /Invalid User API Key/);
      return true;
    },
  );
});
