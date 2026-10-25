type AuthResult = {
  accessToken: string;
  refreshToken: string;
};

type OAuthTokenResult = {
  accessToken: string;
  refreshToken?: string;
  shouldLogout: boolean;
};

class Auth {
  constructor(private readonly baseUrl: string) {}

  public async poll({
    uuid,
    verifier,
    signal,
  }: {
    uuid: string;
    verifier: string;
    signal?: AbortSignal | undefined;
  }) {
    const params = new URLSearchParams({ uuid, verifier });
    return this.fetchJson<AuthResult>(`/auth/poll?${params.toString()}`, {
      headers: { "content-type": "application/json" },
      signal: signal ?? null,
      validator: this.isAuthResult,
    });
  }

  public async exchangeUserApiKey({
    token,
    signal,
  }: {
    token: string;
    signal?: AbortSignal | undefined;
  }) {
    return this.fetchJson<AuthResult>("/auth/exchange_user_api_key", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
      signal: signal ?? null,
      validator: this.isAuthResult,
    });
  }

  /**
   * Refresh a browser-login / IDE session JWT via Cursor's OAuth token endpoint.
   * Long-lived `crsr_` API keys must use {@link exchangeUserApiKey} instead.
   */
  public async refreshOAuthToken({
    refreshToken,
    clientId,
    signal,
  }: {
    refreshToken: string;
    clientId: string;
    signal?: AbortSignal | undefined;
  }) {
    return this.fetchJson<OAuthTokenResult>("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: refreshToken,
      }),
      signal: signal ?? null,
      validator: this.isOAuthTokenResult,
      // Cursor returns 200 with shouldLogout=true for rejected refresh tokens.
      mapJson: (data): OAuthTokenResult | unknown => {
        if (!data || typeof data !== "object") {
          return data;
        }
        const record = data as Record<string, unknown>;
        return {
          accessToken: record["access_token"] ?? record["accessToken"],
          refreshToken: record["refresh_token"] ?? record["refreshToken"],
          shouldLogout: Boolean(record["shouldLogout"]),
        };
      },
    });
  }

  private async fetchJson<T>(
    url: string,
    {
      validator,
      mapJson,
      ...init
    }: RequestInit & {
      validator: (data: unknown) => data is T;
      mapJson?: (data: unknown) => unknown;
    },
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${url}`, init);
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Fetch failed ${url} for ${response.status}: ${error}`);
    }

    let data: unknown = await response.json();
    if (mapJson) {
      data = mapJson(data);
    }
    if (!validator(data)) {
      const error = JSON.stringify(data);
      throw new Error(`Fetch failed ${url} for invalid response: ${error}`);
    }

    return data;
  }

  private isAuthResult(data: unknown): data is AuthResult {
    return (
      typeof data === "object" &&
      data !== null &&
      "accessToken" in data &&
      typeof (data as AuthResult).accessToken === "string" &&
      "refreshToken" in data &&
      typeof (data as AuthResult).refreshToken === "string"
    );
  }

  private isOAuthTokenResult(data: unknown): data is OAuthTokenResult {
    return (
      typeof data === "object" &&
      data !== null &&
      "accessToken" in data &&
      typeof (data as OAuthTokenResult).accessToken === "string" &&
      "shouldLogout" in data &&
      typeof (data as OAuthTokenResult).shouldLogout === "boolean"
    );
  }
}

export default Auth;
